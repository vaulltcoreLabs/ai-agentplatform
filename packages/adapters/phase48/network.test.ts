/**
 * Phase 4.8 §4 — network-latency matrix against REAL TCP paths.
 *
 * CLAIM UNDER TEST: control-plane behavior as a function of network RTT.
 * Phase 4.7 measured Unix-loopback latencies only; this suite routes every
 * query through an RTT-injecting TCP proxy (real kernel sockets) and measures
 * BOTH per-op latency percentiles AND wall-clock throughput.
 *
 * ACCEPTANCE CRITERIA (explicit):
 *  C1: zero unexpected errors at every profile (connection stability).
 *  C2: measured p50 latency grows monotonically with configured RTT
 *      (network realism — the proxy is actually in the path).
 *  C3: observed CONCURRENT throughput at 15 ms RTT must be materially below
 *      the loopback figure, and must NOT be inferred from latency — it is
 *      measured as successful ops / wall-clock seconds.
 *
 * This suite also produces the Phase 4.7 correction data: sequential-p50
 * reciprocal vs observed throughput are reported side by side per profile.
 */

import postgres from "postgres";
import { describe, expect, it } from "bun:test";
import { CAS_ABSENT, SystemClock } from "@vaulltcore/workflow";
import { DistributedQueue } from "@vaulltcore/workflow";
import { migratePostgres, PostgresSharedBackend } from "../pg-backend";
import {
  EVIDENCE_DIR,
  POSTGRES_URL,
  percentiles,
  printGateHeader,
  sampleDbUtilization,
  sleep,
  startDelayProxy,
  writeEvidence,
} from "./harness";

const POOL_MAX = 10;
const SEQ_SAMPLES = 60;
const CONC_WORKERS = 4;
const CONC_OPS_PER_WORKER = 25;

interface ProfileResult {
  profile: string;
  rttConfiguredMs: number;
  rttMeasuredP50Ms: number;
  poolMax: number;
  serverConnections: number | null;
  seq: Record<string, ReturnType<typeof percentiles>>;
  concurrent: Record<
    string,
    {
      workers: number;
      successfulOps: number;
      failedOps: number;
      durationMs: number;
      observedOpsPerSec: number;
      theoreticalOpsPerSecFromSeqP50: number;
    }
  >;
  errors: string[];
}

function parseUpstream(): { host: string; port: number; url: URL } {
  const u = new URL(POSTGRES_URL);
  return {
    host: u.hostname || "127.0.0.1",
    port: Number(u.port || 5432),
    url: u,
  };
}

function poolOptions(u: URL, host: string, port: number) {
  return {
    host,
    port,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    max: POOL_MAX,
  };
}

async function measureRtt(sql: import("postgres").Sql): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await sql`SELECT 1`;
    samples.push(performance.now() - t0);
  }
  return percentiles(samples).p50;
}

if (!POSTGRES_URL) {
  describe.skip("Phase 4.8 network matrix (no Postgres URL)", () => {});
} else {
  describe("Phase 4.8 §4 — network-latency matrix", () => {
    const profiles: { name: string; rttMs: number }[] = [
      { name: "loopback-direct", rttMs: 0 },
      { name: "rtt-1ms", rttMs: 1 },
      { name: "rtt-5ms", rttMs: 5 },
      { name: "rtt-15ms", rttMs: 15 },
      { name: "rtt-40ms", rttMs: 40 },
    ];
    const results: ProfileResult[] = [];

    it("runs the full RTT ladder and records raw evidence", async () => {
      printGateHeader("network-matrix");
      const up = parseUpstream();
      const tag = `net48_${Date.now().toString(36)}`;

      // Fresh-database safety: migrations are idempotent.
      const bootstrap = postgres(poolOptions(up.url, up.host, up.port));
      try {
        await migratePostgres(bootstrap);
      } finally {
        await bootstrap.end({ timeout: 1 });
      }

      for (const prof of profiles) {
        const errors: string[] = [];
        let proxy: Awaited<ReturnType<typeof startDelayProxy>> | null = null;
        let host = up.host;
        let port = up.port;

        if (prof.rttMs > 0) {
          proxy = await startDelayProxy({
            upstreamHost: up.host,
            upstreamPort: up.port,
            rttMs: prof.rttMs,
          });
          host = "127.0.0.1";
          port = proxy.port;
        }

        const pool = postgres(poolOptions(up.url, host, port));
        try {
          // --- actual RTT experienced by a real query ---
          const rttMeasuredP50Ms = await measureRtt(pool);

          // --- sequential latency percentiles ---
          const b = PostgresSharedBackend.fromClient(pool);
          const seq: Record<string, ReturnType<typeof percentiles>> = {};
          const lat = {
            get: [] as number[],
            incr: [] as number[],
            cas: [] as number[],
          };
          for (let i = 0; i < SEQ_SAMPLES; i++) {
            let t0 = performance.now();
            await b.get(`${tag}_seqget`);
            lat.get.push(performance.now() - t0);

            t0 = performance.now();
            await b.incr(`${tag}_seqctr`);
            lat.incr.push(performance.now() - t0);

            t0 = performance.now();
            const cur = (await b.get(`${tag}_seqcas`)) as
              | { n: number }
              | undefined;
            const ok = await b.cas(`${tag}_seqcas`, cur ?? CAS_ABSENT, {
              n: (cur?.n ?? 0) + 1,
            });
            if (!ok && cur !== undefined) errors.push(`cas lost at i=${i}`);
            lat.cas.push(performance.now() - t0);
          }
          seq.get = percentiles(lat.get);
          seq.incr = percentiles(lat.incr);
          seq.cas = percentiles(lat.cas);

          // queue lifecycle latencies at this RTT
          const q = new DistributedQueue(b, new SystemClock());
          const enq: number[] = [];
          const ack: number[] = [];
          const claimBatches: number[][] = [];
          for (let i = 0; i < 20; i++) {
            const id = `${tag}_q${i}`;
            const t0 = performance.now();
            await q.enqueue({ tenantId: "tenant_net48", messageId: id }, { i });
            enq.push(performance.now() - t0);
          }
          for (;;) {
            const t0 = performance.now();
            const claimed = await q.claim(`${tag}_w`, 5, 60_000);
            claimBatches.push([performance.now() - t0]);
            if (claimed.length === 0) break;
            for (const m of claimed) {
              const t1 = performance.now();
              await q.ack(
                { tenantId: "tenant_net48", messageId: m.messageId },
                `${tag}_w`,
              );
              ack.push(performance.now() - t1);
            }
          }
          seq.enqueue = percentiles(enq);
          seq.claimBatchOf5 = percentiles(claimBatches.flat());
          seq.ack = percentiles(ack);

          // --- OBSERVED concurrent throughput (the 4.7 correction) ---
          const concurrent: ProfileResult["concurrent"] = {};
          for (const op of ["incr", "cas"] as const) {
            const workers = Array.from({ length: CONC_WORKERS }, () =>
              PostgresSharedBackend.fromClient(pool),
            );
            let failed = 0;
            const key = `${tag}_thr_${op}`;
            const t0 = performance.now();
            await Promise.all(
              workers.map(async (w) => {
                for (let i = 0; i < CONC_OPS_PER_WORKER; i++) {
                  try {
                    if (op === "incr") await w.incr(key);
                    else {
                      for (;;) {
                        const cur = (await w.get(key)) as
                          | { n: number }
                          | undefined;
                        if (
                          await w.cas(key, cur ?? CAS_ABSENT, {
                            n: (cur?.n ?? 0) + 1,
                          })
                        )
                          break;
                      }
                    }
                  } catch (e) {
                    failed++;
                    errors.push(
                      `${op}: ${String((e as Error).message).slice(0, 80)}`,
                    );
                  }
                }
              }),
            );
            const durationMs = performance.now() - t0;
            const successfulOps = CONC_WORKERS * CONC_OPS_PER_WORKER - failed;
            const observed = (successfulOps / durationMs) * 1000;
            const base =
              op === "incr" ? seq.incr.p50 : seq.cas.p50 + seq.get.p50;
            concurrent[op] = {
              workers: CONC_WORKERS,
              successfulOps,
              failedOps: failed,
              durationMs,
              observedOpsPerSec: observed,
              theoreticalOpsPerSecFromSeqP50: base > 0 ? 1000 / base : 0,
            };
          }

          const util = await sampleDbUtilization(pool);
          results.push({
            profile: prof.name,
            rttConfiguredMs: prof.rttMs,
            rttMeasuredP50Ms,
            poolMax: POOL_MAX,
            serverConnections: util.total,
            seq,
            concurrent,
            errors,
          });

          console.log(
            `\n[profile ${prof.name}] rttCfg=${prof.rttMs}ms rttMeasured(p50)=${rttMeasuredP50Ms.toFixed(2)}ms`,
          );
          for (const [op, p] of Object.entries(seq)) {
            console.log(
              `  ${op.padEnd(14)} p50=${p.p50.toFixed(2)} p95=${p.p95.toFixed(2)} p99=${p.p99.toFixed(2)} max=${p.max.toFixed(2)} (n=${p.n})`,
            );
          }
          for (const [op, t] of Object.entries(concurrent)) {
            console.log(
              `  ${op}@${CONC_WORKERS}w observed=${t.observedOpsPerSec.toFixed(0)} ops/s over ${t.durationMs.toFixed(0)}ms | seq-p50-reciprocal=${t.theoreticalOpsPerSecFromSeqP50.toFixed(0)} ops/s (NOT throughput)`,
            );
          }
        } finally {
          await pool.end({ timeout: 1 });
          if (proxy) await proxy.close();
        }
      }

      writeEvidence("network-matrix.json", {
        collectedAt: new Date().toISOString(),
        evidenceDir: EVIDENCE_DIR,
        profiles: results,
      });

      // C1: no unexpected errors anywhere
      const allErrors = results.flatMap((r) =>
        r.errors.map((e) => `${r.profile}: ${e}`),
      );
      expect(allErrors).toEqual([]);

      // C2: monotonic growth of measured p50 with configured RTT (incr op)
      const incrP50s = results.map((r) => r.seq.incr!.p50);
      for (let i = 1; i < incrP50s.length; i++) {
        expect(incrP50s[i]!).toBeGreaterThanOrEqual(incrP50s[i - 1]! - 1);
      }
      expect(results[results.length - 1]!.seq.incr!.p50).toBeGreaterThan(
        results[0]!.seq.incr!.p50 * 10,
      );

      // C3: observed throughput degrades materially with RTT (measured)
      const thrLoopback = results[0]!.concurrent.incr!.observedOpsPerSec;
      const thr15 = results.find((r) => r.profile === "rtt-15ms")!.concurrent
        .incr!.observedOpsPerSec;
      expect(thr15).toBeLessThan(thrLoopback * 0.6);

      await sleep(10);
    }, 170_000);
  });
}
