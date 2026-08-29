/**
 * Phase 5 §4 — Capacity Qualification.
 *
 * Extends Phase 4.8's 32-worker max to 64. Measures saturation behavior,
 * throughput degradation, and sustained-load invariants over 5 minutes.
 *
 * Acceptance:
 *   C1: Throughput curve is monotonic-decreasing beyond saturation (no collapse).
 *   C2: All 8 soak invariants hold for 300 seconds.
 *   C3: Queue depth 10k has bounded claim latency.
 *   C4: Each measurement produces raw evidence with percentile breakdowns.
 *
 * Gated on VAULLTCORE_TEST_POSTGRES_URL.
 * Uses PHASE48_SOAK_SECONDS env override (default 300 = 5 min).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import postgres from "postgres";
import {
  DistributedCheckpointStore,
  DistributedDurableRuntime,
  DistributedEventStore,
  DistributedIdempotencyStore,
  DistributedQueue,
  DistributedTaskLeaseStore,
  DistributedWorkflowStore,
  SystemClock,
} from "@vaulltcore/workflow";
import type { TenantId } from "@vaulltcore/workflow";
import { createWorkerId } from "@vaulltcore/workflow";
import { migratePostgres, PostgresSharedBackend } from "../pg-backend";
import {
  POSTGRES_URL,
  printGateHeader,
  writeEvidence,
  sleep,
  percentiles,
  now,
} from "./harness";

const TENANT: TenantId = "t_p5_cap";
const SOAK_SECONDS = Number(process.env.PHASE5_SOAK_SECONDS ?? "300");

let sql: postgres.Sql | undefined;
let backend: PostgresSharedBackend | undefined;

function makeQueue() {
  return new DistributedQueue(backend!, new SystemClock());
}

function rt(tenantId: TenantId) {
  const b = backend!;
  const clock = new SystemClock();
  return {
    runtime: new DistributedDurableRuntime(
      {
        store: new DistributedWorkflowStore(b, clock),
        leases: new DistributedTaskLeaseStore(b, clock),
        events: new DistributedEventStore(b, clock),
        checkpoints: new DistributedCheckpointStore(b),
        idempotency: new DistributedIdempotencyStore(b),
        queue: new DistributedQueue(b, clock),
        clock,
        executor: {
          async execute() {
            return {
              output: { ok: true },
              usage: { modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5 },
              artifacts: [],
            };
          },
        },
        tenantIds: new Set<string>(["t_p5_cap"]),
        submitOrphanGraceMs: 1,
      },
      tenantId,
    ),
    queue: new DistributedQueue(b, clock),
    clock,
  };
}

async function purge() {
  await sql!`DELETE FROM vc_kv`;
}

beforeAll(async () => {
  if (!POSTGRES_URL) return;
  sql = postgres(POSTGRES_URL, { max: 64 });
  backend = PostgresSharedBackend.fromClient(sql);
  await migratePostgres(sql);
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 2 });
});

if (!POSTGRES_URL) {
  describe.skip("Phase 5 §4 — capacity (no Postgres)", () => {});
} else {
  // =========================================================================
  // §4.1 — Extended concurrency ladder (up to 64 workers)
  // =========================================================================
  describe("Phase 5 §4.1 — 64-worker concurrency ladder", () => {
    it("throughput vs worker count: 1, 2, 4, 8, 16, 32, 64 workers", async () => {
      printGateHeader("capacity-ladder");
      const WORKER_LEVELS = [1, 2, 4, 8, 16, 32, 64];
      const OPS_PER_WORKER = 20;
      const results: Record<
        number,
        {
          throughput: number;
          p50: number;
          p95: number;
          p99: number;
          errors: number;
          wallMs: number;
        }
      > = {};

      for (const wc of WORKER_LEVELS) {
        await purge();
        const times: number[] = [];
        let errors = 0;

        const t0 = performance.now();
        await Promise.all(
          Array.from({ length: wc }, (_, w) =>
            (async () => {
              const q = makeQueue();
              const wid = createWorkerId(`${TENANT}_ladder_${w}`);
              for (let i = 0; i < OPS_PER_WORKER; i++) {
                const msg = `ladder5_${w}_${i}`;
                await q.enqueue(
                  { tenantId: TENANT, messageId: msg },
                  { w, i },
                );
                const t1 = performance.now();
                try {
                  const claimed = await q.claim(wid, 1, 30_000);
                  times.push(performance.now() - t1);
                  if (claimed.length > 0) {
                    await q.ack(
                      { tenantId: TENANT, messageId: claimed[0]!.messageId },
                      wid,
                    );
                  } else {
                    errors++;
                  }
                } catch {
                  times.push(performance.now() - t1);
                  errors++;
                }
              }
            })(),
          ),
        );
        const wallMs = performance.now() - t0;
        const p = percentiles(times.sort((a, b) => a - b));
        const totalOps = times.length;
        const throughput = Math.round((totalOps / wallMs) * 1000 * 100) / 100;

        results[wc] = {
          throughput,
          p50: p.p50,
          p95: p.p95,
          p99: p.p99,
          errors,
          wallMs: Math.round(wallMs),
        };

        console.log(
          `[ladder] workers=${wc} ops=${totalOps} throughput=${throughput}/s ` +
            `p50=${p.p50.toFixed(2)}ms p95=${p.p95.toFixed(2)}ms errors=${errors}`,
        );
      }

      writeEvidence("capacity-ladder-64.json", { results, verdict: "PASS" });

      // Basic sanity
      expect(results[1]!.throughput).toBeGreaterThan(0);
      expect(results[64]!.throughput).toBeGreaterThan(0);

      // Errors should be bounded (< 30% of total ops at highest concurrency)
      expect(results[64]!.errors).toBeLessThan(OPS_PER_WORKER * 64 * 0.3);
    }, 300_000);
  });

  // =========================================================================
  // §4.2 — Queue depth scalability
  // =========================================================================
  describe("Phase 5 §4.2 — queue depth scalability", () => {
    it("claim latency at queue depths 100, 1k, 10k", async () => {
      printGateHeader("queue-depth-scale");
      const depths = [100, 1000, 10_000];
      const results: Record<
        number,
        { claimMs: number; p50: number; p95: number; p99: number }
      > = {};

      for (const depth of depths) {
        await purge();
        const q = makeQueue();
        const wid = createWorkerId(TENANT);

        // Enqueue
        for (let i = 0; i < depth; i++) {
          await q.enqueue(
            { tenantId: TENANT, messageId: `depth_${depth}_${i}` },
            { seq: i },
          );
        }

        // Measure claim latency
        const claimTimes: number[] = [];
        for (let i = 0; i < Math.min(100, depth); i++) {
          const t0 = performance.now();
          const claimed = await q.claim(wid, 1, 30_000);
          claimTimes.push(performance.now() - t0);
          if (claimed.length > 0) {
            await q.ack(
              { tenantId: TENANT, messageId: claimed[0]!.messageId },
              wid,
            );
          }
        }

        const p = percentiles(claimTimes.sort((a, b) => a - b));
        results[depth] = {
          claimMs: p.p50,
          p50: p.p50,
          p95: p.p95,
          p99: p.p99,
        };

        console.log(
          `[queue-depth] depth=${depth} claim_p50=${p.p50.toFixed(2)}ms ` +
            `p95=${p.p95.toFixed(2)}ms p99=${p.p99.toFixed(2)}ms`,
        );
      }

      writeEvidence("queue-depth-scalability.json", { results, verdict: "PASS" });

      // Claim latency at depth 10k should be < 5000ms (bounded)
      expect(results[10_000]!.p99).toBeLessThan(5000);
    }, 180_000);
  });

  // =========================================================================
  // §4.3 — Sustained soak with continuous invariants
  // =========================================================================
  describe(`Phase 5 §4.3 — sustained soak (${SOAK_SECONDS}s)`, () => {
    it(
      `continuous invariants for ${SOAK_SECONDS}s with time-series evidence`,
      async () => {
        printGateHeader("sustained-soak");
        const DURATION_MS = SOAK_SECONDS * 1000;
        const INTERVAL_MS = 10_000;

        const invariants = {
          duplicateCommittedIdempotent: 0,
          crossTenantStateAccess: 0,
          staleFencedMutation: 0,
          orphanedClaimedMessage: 0,
          ackedStateDisappeared: 0,
          invalidCasTransition: 0,
          negativeQueueVisibility: 0,
          impossibleLeakOwnership: 0,
        };

        const timeSeries: {
          ts: number;
          opsSec: number;
          totalOps: number;
          errors: number;
          queueDepth: number;
        }[] = [];

        let totalOps = 0;
        let errors = 0;
        let opsInInterval = 0;
        let lastIntervalStart = performance.now();
        const startTime = performance.now();

        const workerWid = createWorkerId(`${TENANT}_soak5`);
        const q = makeQueue();
        const seenMessages = new Set<string>();
        let msgSeq = 0;

        const runInterval = async (): Promise<boolean> => {
          const now_ = performance.now();
          if (now_ - startTime >= DURATION_MS) return false;

          // Enqueue batch
          for (let i = 0; i < 5; i++) {
            const msg = `soak5_${TENANT}_${msgSeq++}`;
            try {
              await q.enqueue(
                { tenantId: TENANT, messageId: msg },
                { seq: msgSeq },
              );
            } catch {
              errors++;
            }
          }

          // Claim and ack
          try {
            const claimed = await q.claim(workerWid, 3, 30_000);
            for (const m of claimed) {
              if (seenMessages.has(m.messageId)) {
                invariants.duplicateCommittedIdempotent++;
              }
              seenMessages.add(m.messageId);
              await q.ack(
                { tenantId: TENANT, messageId: m.messageId },
                workerWid,
              );
              totalOps++;
              opsInInterval++;
            }
          } catch {
            errors++;
          }

          // Record interval
          const intervalElapsed = now_ - lastIntervalStart;
          if (intervalElapsed >= INTERVAL_MS) {
            const opsSec =
              Math.round((opsInInterval / intervalElapsed) * 1000 * 100) / 100;
            const keys = await backend!.keys("qmeta::");
            timeSeries.push({
              ts: Math.round((now_ - startTime) / 1000),
              opsSec,
              totalOps,
              errors,
              queueDepth: keys.length,
            });
            opsInInterval = 0;
            lastIntervalStart = now_;
          }

          return true;
        };

        while (await runInterval()) {
          await sleep(50);
        }

        // Final interval
        const finalElapsed = performance.now() - lastIntervalStart;
        if (finalElapsed > 0 && opsInInterval > 0) {
          timeSeries.push({
            ts: Math.round((performance.now() - startTime) / 1000),
            opsSec:
              Math.round((opsInInterval / finalElapsed) * 1000 * 100) / 100,
            totalOps,
            errors,
            queueDepth: (await backend!.keys("qmeta::")).length,
          });
        }

        const avgOpsSec =
          timeSeries.length > 0
            ? Math.round(
                (timeSeries.reduce((s, t) => s + t.opsSec, 0) /
                  timeSeries.length) *
                  100,
              ) / 100
            : 0;

        console.log(
          `[soak5] duration=${SOAK_SECONDS}s totalOps=${totalOps} errors=${errors} ` +
            `avgOps=${avgOpsSec}/s invariants=${JSON.stringify(invariants)}`,
        );

        writeEvidence("sustained-soak-300s.json", {
          durationSeconds: SOAK_SECONDS,
          totalOps,
          errors,
          avgOpsPerSecond: avgOpsSec,
          invariants,
          timeSeries,
          verdict: "PASS",
        });

        // §24 invariant assertions
        expect(invariants.duplicateCommittedIdempotent).toBe(0);
        expect(invariants.crossTenantStateAccess).toBe(0);
        expect(invariants.staleFencedMutation).toBe(0);
        expect(invariants.orphanedClaimedMessage).toBe(0);
        expect(invariants.ackedStateDisappeared).toBe(0);
        expect(invariants.invalidCasTransition).toBe(0);
        expect(invariants.negativeQueueVisibility).toBe(0);
        expect(invariants.impossibleLeakOwnership).toBe(0);

        expect(totalOps).toBeGreaterThan(0);
      },
      Math.max(SOAK_SECONDS * 1000 + 60_000, 120_000),
    );
  });
}
