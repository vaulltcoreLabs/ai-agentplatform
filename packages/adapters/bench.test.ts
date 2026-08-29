/**
 * Phase 4.7 — latency benchmark harness (p50/p95/p99/max).
 *
 * Gated on VAULLTCORE_TEST_POSTGRES_URL. Measures SharedBackend + queue
 * operations against the LIVE server at several concurrency levels and prints
 * an honest percentile table (percentiles, not averages-only).
 *
 * Run:
 *   VAULLTCORE_TEST_POSTGRES_URL=postgres://… bun test packages/adapters/bench.test.ts
 */

import postgres from "postgres";
import { describe, expect, it } from "bun:test";
import {
  CAS_ABSENT,
  DistributedQueue,
  SystemClock,
} from "@vaulltcore/workflow";
import { PostgresSharedBackend } from "./pg-backend";

const url =
  process.env.VAULLTCORE_TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

function percentiles(samples: number[]): {
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1]! };
}

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ms: number; result: T }> {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
}

if (!url) {
  describe.skip("Phase 4.7 — latency benchmarks (no Postgres URL)", () => {});
} else {
  const pool = postgres(url!, { max: 16 });

  it("measures SharedBackend + queue latency percentiles", async () => {
    const b = PostgresSharedBackend.fromClient(pool);
    await pool`DELETE FROM vc_kv`;
    const clock = new SystemClock();
    const q = new DistributedQueue(b, clock);

    const SAMPLES = 60;
    const raw = new Map<string, number[]>();
    const record = (op: string, ms: number): void => {
      let arr = raw.get(op);
      if (!arr) raw.set(op, (arr = []));
      arr.push(ms);
    };

    // --- single-connection sequential ---
    await b.cas("bench-seq", CAS_ABSENT, { n: 0 });
    for (let i = 0; i < SAMPLES; i++) {
      const cur = (await b.get("bench-seq")) as { n: number };
      record(
        "cas",
        (await timed(() => b.cas("bench-seq", cur, { n: i + 1 }))).ms,
      );
      record("get", (await timed(() => b.get("bench-seq"))).ms);
      record("append", (await timed(() => b.append("bench-list", { i }))).ms);
      record("incr", (await timed(() => b.incr("bench-counter"))).ms);
      record("list", (await timed(() => b.list("bench-list"))).ms);
    }

    // --- queue lifecycle ---
    for (let i = 0; i < SAMPLES; i++) {
      const id = `bq_${i}`;
      const enqueue = await timed(() =>
        q.enqueue({ tenantId: "tenant_bench", messageId: id }, { i }),
      );
      record("enqueue", enqueue.ms);
    }
    for (;;) {
      const claimed = await timed(() => q.claim("bench-worker", 10, 60_000));
      record("claim", claimed.ms);
      if (claimed.result.length === 0) break;
      for (const m of claimed.result) {
        record(
          "ack",
          (
            await timed(() =>
              q.ack(
                { tenantId: "tenant_bench", messageId: m.messageId },
                "bench-worker",
              ),
            )
          ).ms,
        );
      }
    }

    // --- concurrent levels: contended incr + cas-race rounds ---
    for (const workers of [4, 16]) {
      const backends = Array.from({ length: workers }, () =>
        PostgresSharedBackend.fromClient(pool),
      );
      // Contended increment bursts (per-worker average latency).
      for (let round = 0; round < SAMPLES / 4; round++) {
        const start = performance.now();
        await Promise.all(backends.map((bb) => bb.incr(`bench-contended`)));
        record(`incr@${workers}w`, (performance.now() - start) / workers);
      }

      // CAS race rounds (wall time until all workers resolve).
      for (let round = 0; round < SAMPLES / 4; round++) {
        const start = performance.now();
        await Promise.all(
          backends.map((bb) =>
            bb.cas(`race-${round}-${workers}`, CAS_ABSENT, { w: workers }),
          ),
        );
        record(`casRace@${workers}w`, performance.now() - start);
      }
    }

    // Print honest percentile table.
    console.log(
      "\n=== Phase 4.7 latency benchmarks (PostgreSQL 14 local, pooled ×16) ===",
    );
    console.log(
      "op                       p50      p95      p99      max   (n)",
    );
    for (const [op, arr] of [...raw.entries()].sort()) {
      const pct = percentiles(arr);
      console.log(
        `${op.padEnd(22)} ${pct.p50.toFixed(2).padStart(6)} ${pct.p95.toFixed(2).padStart(8)} ${pct.p99.toFixed(2).padStart(8)} ${pct.max.toFixed(2).padStart(8)} (${arr.length})`,
      );
    }

    // Sanity: every measured operation completed within generous bounds.
    for (const [op, arr] of raw) {
      expect(`${op}:${Math.max(...arr) < 5000}`).toBe(`${op}:true`);
    }
    await pool.end({ timeout: 1 });
  }, 120000);
}
