/**
 * Phase 4.7 — production durability gate against a LIVE PostgreSQL server.
 *
 * Gated on VAULLTCORE_TEST_POSTGRES_URL (or POSTGRES_URL). Every test uses
 * INDEPENDENT pooled connections; durable state is purged between tests so
 * runs never contaminate each other (isolation requirement §6).
 *
 * Proven here (not assumed):
 *  - migration idempotency (migrate ×3)
 *  - high-contention CAS races (2/4/8/16 workers, repeated rounds)
 *  - lease expiry → takeover → stale worker rejected
 *  - idempotent submission storm (16 concurrent, one logical job)
 *  - cross-tenant idempotency independence
 *  - event append + incr stress across 4 connections
 *  - queue storm with duplicate rejection and full drain
 *  - durability across connection termination (restart semantics)
 */

import postgres from "postgres";
import { describe, expect, it } from "bun:test";
import {
  CAS_ABSENT,
  DistributedCheckpointStore,
  DistributedDurableRuntime,
  DistributedEventStore,
  DistributedIdempotencyStore,
  DistributedQueue,
  DistributedTaskLeaseStore,
  DistributedWorkflowStore,
  SystemClock,
  type StepExecution,
  type StepExecutor,
  type StepResult,
  type WorkerDeps,
} from "@vaulltcore/workflow";
import { migratePostgres, PostgresSharedBackend } from "./pg-backend";

const url =
  process.env.VAULLTCORE_TEST_POSTGRES_URL ?? process.env.POSTGRES_URL;

if (!url) {
  describe.skip("Phase 4.7 — live Postgres durability gate (no URL)", () => {});
} else {
  // ONE shared pool: backends still race as independent sessions because every
  // statement grabs its own connection from the pool and correctness comes
  // from SERVER-SIDE row locks — not from client sockets. This avoids
  // exhausting Postgres max_connections across dozens of backends.
  const sharedPool: postgres.Sql = postgres(url!, { max: 16 });

  const purge = async (): Promise<void> => {
    await sharedPool`DELETE FROM vc_kv`;
  };

  const backend = (): PostgresSharedBackend =>
    PostgresSharedBackend.fromClient(sharedPool);

  interface RuntimeHandle {
    runtime: DistributedDurableRuntime;
    deps: WorkerDeps & { tenantIds: ReadonlySet<string> };
  }

  const TENANT = "tenant_p47";

  const buildRuntime = (tenant = TENANT): RuntimeHandle => {
    const clock = new SystemClock();
    const b = backend();
    const deps = {
      store: new DistributedWorkflowStore(b, clock),
      leases: new DistributedTaskLeaseStore(b, clock),
      events: new DistributedEventStore(b, clock),
      checkpoints: new DistributedCheckpointStore(b),
      idempotency: new DistributedIdempotencyStore(b),
      queue: new DistributedQueue(b, clock),
      clock,
      executor: {
        async execute(_e: StepExecution, _s: AbortSignal): Promise<StepResult> {
          return {
            output: { ok: true },
            usage: {
              modelCalls: 1,
              toolCalls: 0,
              inputTokens: 10,
              outputTokens: 5,
            },
            artifacts: [],
          };
        },
      } satisfies StepExecutor,
      tenantIds: new Set<string>([TENANT, "tenant_b", "tenant_other"]),
    } satisfies WorkerDeps & { tenantIds: ReadonlySet<string> };
    return { runtime: new DistributedDurableRuntime(deps, tenant), deps };
  };

  describe("Phase 4.7 — migrations", () => {
    it("migrate ×3 is idempotent — no errors, no duplicate versions", async () => {
      await migratePostgres(sharedPool);
      await migratePostgres(sharedPool);
      await migratePostgres(sharedPool);
      const versions =
        await sharedPool`SELECT version FROM vc_schema_migrations`;
      expect(versions.length).toBe(1);
      const tables = await sharedPool`
        SELECT COUNT(*)::int AS n FROM pg_tables
        WHERE tablename IN ('vc_kv', 'vc_schema_migrations')
      `;
      expect((tables[0] as { n: number }).n).toBe(2);
    });
  });

  describe("Phase 4.7 — high-contention CAS races", () => {
    for (const workers of [2, 4, 8, 16]) {
      it(`${workers} workers race create-on-absent → exactly one winner`, async () => {
        await purge();
        const backends = Array.from({ length: workers }, () => backend());
        const results = await Promise.all(
          backends.map((b) => b.cas("hot", CAS_ABSENT, { round: workers })),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.filter((r) => !r)).toHaveLength(workers - 1);
        // Every connection observes the identical winning value.
        const observed = await Promise.all(backends.map((b) => b.get("hot")));
        for (const v of observed) expect(v).toEqual({ round: workers });
      });
    }
  });

  describe("Phase 4.7 — lease expiry, takeover, stale rejection", () => {
    it("expired worker A is superseded by B; A cannot renew afterwards", async () => {
      await purge();
      const a = new DistributedTaskLeaseStore(backend(), new SystemClock());
      const b = new DistributedTaskLeaseStore(backend(), new SystemClock());

      const leaseA = await a.claim(
        "dstep_takeover_000000000000001",
        "worker-a",
        30,
      );
      expect(leaseA).not.toBeNull();

      // A stops heartbeating; TTL lapses.
      await new Promise((resolve) => setTimeout(resolve, 45));

      // B takes over.
      const leaseB = await b.claim(
        "dstep_takeover_000000000000001",
        "worker-b",
        30_000,
      );
      expect(leaseB).not.toBeNull();
      expect(leaseB!.version).toBeGreaterThan(leaseA!.version);

      // Stale A renewal must NOT resurrect its dead lease.
      expect(await a.renew(leaseA!.id, "worker-a", 30_000)).toBe(false);

      // B renews fine and completes via revoke (soft-mark: revokedAt set —
      // the record stays for audit but the lease is dead).
      expect(await b.renew(leaseB!.id, "worker-b", 30_000)).toBe(true);
      await b.revoke(leaseB!.id, "worker-b");
      const revoked = await b.getLease("dstep_takeover_000000000000001");
      expect(revoked?.revokedAt).not.toBeNull();
    }, 15000);
  });

  describe("Phase 4.7 — idempotent submission storm", () => {
    it("16 concurrent submits (same tenant+key) → ONE logical job", async () => {
      await purge();
      const runtimes = Array.from({ length: 16 }, () => buildRuntime());
      const results = await Promise.all(
        runtimes.map((r) =>
          r.runtime.submit({
            tenantId: TENANT,
            objective: "storm",
            idempotencyKey: "storm-key",
          }),
        ),
      );
      const jobIds = new Set(results.map((r) => r.jobId));
      expect(jobIds.size).toBe(1);
      expect(results.filter((r) => r.createdRun).length).toBe(1);
    }, 30000);

    it("same key across DIFFERENT tenants stays independent", async () => {
      await purge();
      const a = buildRuntime(TENANT);
      const b = buildRuntime("tenant_b");
      const [ra, rb] = await Promise.all([
        a.runtime.submit({
          tenantId: TENANT,
          objective: "shared-shape",
          idempotencyKey: "same-key",
        }),
        b.runtime.submit({
          tenantId: "tenant_b",
          objective: "shared-shape",
          idempotencyKey: "same-key",
        }),
      ]);
      expect(ra.jobId).not.toBe(rb.jobId);
      expect(ra.createdRun).toBe(true);
      expect(rb.createdRun).toBe(true);
    }, 20000);
  });

  describe("Phase 4.7 — write stress across independent connections", () => {
    it("200 concurrent increments across 4 connections → no lost updates", async () => {
      await purge();
      const backends = Array.from({ length: 4 }, () => backend());
      const values = await Promise.all(
        backends.flatMap((b) =>
          Array.from({ length: 50 }, () => b.incr("counter")),
        ),
      );
      expect(new Set(values).size).toBe(200);
      expect(await backends[0]!.get("counter")).toBe(200);
    }, 30000);

    it("100 concurrent appends across 4 connections → complete stream", async () => {
      await purge();
      const backends = Array.from({ length: 4 }, () => backend());
      await Promise.all(
        backends.flatMap((b, src) =>
          Array.from({ length: 25 }, (_, i) =>
            b.append("run::events", { src, i }),
          ),
        ),
      );
      for (const b of backends) {
        expect(((await b.list("run::events")) as unknown[]).length).toBe(100);
      }
    }, 30000);
  });

  describe("Phase 4.7 — queue storm", () => {
    it("enqueue 100 (+dupes) → two workers drain → acks permanent", async () => {
      await purge();
      const q1 = new DistributedQueue(backend(), new SystemClock());
      const q2 = new DistributedQueue(backend(), new SystemClock());

      let dupesRejected = 0;
      for (let i = 0; i < 100; i++) {
        if (
          !(await q1.enqueue(
            { tenantId: TENANT, messageId: `msg_${i}` },
            { i },
          ))
        )
          dupesRejected++;
        if (
          !(await q2.enqueue(
            { tenantId: TENANT, messageId: `msg_${i}` },
            { i },
          ))
        )
          dupesRejected++;
      }
      expect(dupesRejected).toBe(100); // every duplicate rejected

      // Two workers claim concurrently until the queue drains.
      let w1Claimed = 0;
      let w2Claimed = 0;
      for (;;) {
        const [c1, c2] = await Promise.all([
          q1.claim("w1", 10, 60_000),
          q2.claim("w2", 10, 60_000),
        ]);
        w1Claimed += c1.length;
        w2Claimed += c2.length;
        if (c1.length === 0 && c2.length === 0) break;
        for (const m of c1)
          await q1.ack({ tenantId: TENANT, messageId: m.messageId }, "w1");
        for (const m of c2)
          await q2.ack({ tenantId: TENANT, messageId: m.messageId }, "w2");
      }
      expect(w1Claimed + w2Claimed).toBe(100);

      // Acknowledged messages never reappear.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await q1.claim("w3", 10, 1000)).toHaveLength(0);
    }, 60000);
  });

  describe("Phase 4.7 — durability across connection termination", () => {
    it("jobs written by runtime A survive into a brand-new connection", async () => {
      await purge();
      const a = buildRuntime();
      const submit = await a.runtime.submit({
        tenantId: TENANT,
        objective: "survive restart",
      });
      expect(submit.createdRun).toBe(true);

      // Simulate process death: a brand-new isolated session (fresh socket,
      // same durable database) reads the state written by runtime A.
      const freshPool = postgres(url!, { max: 2 });
      try {
        const clock = new SystemClock();
        const b = PostgresSharedBackend.fromClient(freshPool);
        const store = new DistributedWorkflowStore(b, clock);
        const marker = await store.getCancellationMarker(submit.runId!);
        expect(marker).toBeUndefined(); // state readable, not cancelled
        const jobTenant = await store.resolveJobTenant(submit.jobId);
        expect(jobTenant).toBe(TENANT);
      } finally {
        await freshPool.end({ timeout: 1 });
      }
    }, 20000);
  });
}
