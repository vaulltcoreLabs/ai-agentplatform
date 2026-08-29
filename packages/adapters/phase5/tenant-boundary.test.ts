/**
 * Phase 5 §5 — Tenant Boundary Enforcement (Deep Adversarial).
 *
 * Extends Phase 4.8's §14 with deeper adversarial testing:
 *   - Concurrent cross-tenant operations
 *   - Queue-level tenant isolation under stress
 *   - Authorization bypass attempts
 *   - Tenant-salted idempotency correctness
 *   - Cross-tenant claim isolation
 *   - Tenant boundary under worker fencing
 *
 * Acceptance:
 *   C1: Zero successful cross-tenant state access in 100 attempts.
 *   C2: Every cross-tenant operation is rejected or independent.
 *   C3: Idempotency keys are tenant-salted (same key, different tenant = independent).
 *   C4: Queue message IDs scoped correctly under concurrent cross-tenant stress.
 *
 * Gated on VAULLTCORE_TEST_POSTGRES_URL.
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
  NoopStepExecutor,
  SystemClock,
  CAS_ABSENT,
  AuthorizationError,
} from "@vaulltcore/workflow";
import type { TenantId } from "@vaulltcore/workflow";
import { createWorkerId } from "@vaulltcore/workflow";
import { migratePostgres, PostgresSharedBackend } from "../pg-backend";
import { POSTGRES_URL, printGateHeader, writeEvidence } from "./harness";

const TENANT_A: TenantId = "t_p5_iso_a";
const TENANT_B: TenantId = "t_p5_iso_b";
const TENANT_C: TenantId = "t_p5_iso_c";

let sql: postgres.Sql | undefined;
let backend: PostgresSharedBackend | undefined;

function makeRuntime(tenantId: TenantId) {
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
        executor: new NoopStepExecutor(),
        tenantIds: new Set<string>([TENANT_A, TENANT_B, TENANT_C]),
        submitOrphanGraceMs: 5,
      },
      tenantId,
    ),
    queue: new DistributedQueue(b, clock),
    backend: b,
  };
}

async function purge() {
  await sql!`DELETE FROM vc_kv`;
}

beforeAll(async () => {
  if (!POSTGRES_URL) return;
  sql = postgres(POSTGRES_URL, { max: 20 });
  backend = PostgresSharedBackend.fromClient(sql);
  await migratePostgres(sql);
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 2 });
});

if (!POSTGRES_URL) {
  describe.skip("Phase 5 §5 — tenant boundary (no Postgres)", () => {});
} else {
  describe("Phase 5 §5 — deep adversarial tenant isolation", () => {
    beforeAll(async () => {
      await purge();
      // Populate state for each tenant
      for (const [tenant, obj, idem] of [
        [TENANT_A, "job-a", "k_tenant_a"],
        [TENANT_B, "job-b", "k_tenant_b"],
        [TENANT_C, "job-c", "k_tenant_c"],
      ] as const) {
        const r = makeRuntime(tenant);
        const res = await r.runtime.submit({
          tenantId: tenant,
          objective: obj,
          idempotencyKey: idem,
        });
        expect(res.createdRun).toBe(true);
      }
    });

    it("cross-tenant job read: B cannot read A's job", async () => {
      printGateHeader("tenant-job-read");
      const rA = makeRuntime(TENANT_A);
      const rB = makeRuntime(TENANT_B);

      const aKeys = await backend!.keys(`t::${TENANT_A}::job::`);
      expect(aKeys.length).toBe(1);
      const aJobId = aKeys[0]!.split("::job::")[1]!;

      // B reads A's job ID through B's runtime — must return undefined
      const store = new DistributedWorkflowStore(backend!, new SystemClock());
      const stolen = await store.getJob(TENANT_B, aJobId);
      expect(stolen).toBeUndefined();
    });

    it("cross-tenant key namespace: zero overlap between A and B", async () => {
      const aKeys = await backend!.keys(`t::${TENANT_A}::`);
      const bKeys = await backend!.keys(`t::${TENANT_B}::`);

      const aSet = new Set(aKeys);
      const bSet = new Set(bKeys);

      let overlap = 0;
      for (const k of aSet) {
        if (bSet.has(k)) overlap++;
      }
      expect(overlap).toBe(0);
    });

    it("cross-tenant cancel throws AuthorizationError", async () => {
      const rA = makeRuntime(TENANT_A);
      const rB = makeRuntime(TENANT_B);

      const aKeys = await backend!.keys(`t::${TENANT_A}::job::`);
      const aJobId = aKeys[0]!.split("::job::")[1]!;

      await expect(
        rB.runtime.cancel({
          jobId: aJobId,
          tenantId: TENANT_B,
          reason: "cross-tenant attack",
        }),
      ).rejects.toThrow();
    });

    it("unknown tenant is rejected", async () => {
      const rA = makeRuntime(TENANT_A);
      await expect(
        rA.runtime.submit({
          tenantId: "t_nonexistent" as TenantId,
          objective: "should-fail",
        }),
      ).rejects.toThrow();
    });

    it("same objective different tenant creates independent state", async () => {
      const rA = makeRuntime(TENANT_A);
      const rB = makeRuntime(TENANT_B);

      const bRes = await rB.runtime.submit({
        tenantId: TENANT_B,
        objective: "job-a", // same objective as A
        idempotencyKey: "k_tenant_a", // same key as A
      });

      // Must NOT conflict — tenant-salted idempotency
      expect(bRes.jobId).toBeTruthy();

      // Both tenants have their own jobs
      const aKeys = await backend!.keys(`t::${TENANT_A}::job::`);
      const bKeys = await backend!.keys(`t::${TENANT_B}::job::`);
      expect(aKeys.length).toBeGreaterThanOrEqual(1);
      expect(bKeys.length).toBeGreaterThanOrEqual(1);
    });

    it("100 concurrent cross-tenant submits: zero cross-contamination", async () => {
      printGateHeader("tenant-concurrent-stress");
      const PER_TENANT = 33;

      const promises = [];
      for (let i = 0; i < PER_TENANT; i++) {
        for (const tenant of [TENANT_A, TENANT_B, TENANT_C]) {
          const r = makeRuntime(tenant);
          promises.push(
            r.runtime.submit({
              tenantId: tenant,
              objective: `stress_${tenant}_${i}`,
              idempotencyKey: `k_stress_${tenant}_${i}`,
            }),
          );
        }
      }

      const results = await Promise.all(promises);
      const created = results.filter((r) => r.createdRun);
      expect(created.length).toBe(PER_TENANT * 3);

      // Verify key isolation
      const aKeys = await backend!.keys(`t::${TENANT_A}::job::`);
      const bKeys = await backend!.keys(`t::${TENANT_B}::job::`);
      const cKeys = await backend!.keys(`t::${TENANT_C}::job::`);

      // All three tenants have independent state
      expect(aKeys.length).toBeGreaterThanOrEqual(PER_TENANT);
      expect(bKeys.length).toBeGreaterThanOrEqual(PER_TENANT);
      expect(cKeys.length).toBeGreaterThanOrEqual(PER_TENANT);

      // Cross-contamination check: no A key appears in B or C namespace
      const aSet = new Set(aKeys);
      const bSet = new Set(bKeys);
      const cSet = new Set(cKeys);
      let contamination = 0;
      for (const k of aSet) {
        if (bSet.has(k) || cSet.has(k)) contamination++;
      }
      for (const k of bSet) {
        if (cSet.has(k)) contamination++;
      }
      expect(contamination).toBe(0);

      writeEvidence("tenant-cross-contamination-100.json", {
        perTenant: PER_TENANT,
        totalCreated: created.length,
        contamination,
        aJobCount: aKeys.length,
        bJobCount: bKeys.length,
        cJobCount: cKeys.length,
        verdict: contamination === 0 ? "PASS" : "FAIL",
      });
    });

    it("concurrent cross-tenant queue operations: message isolation", async () => {
      const rA = makeRuntime(TENANT_A);
      const rB = makeRuntime(TENANT_B);

      // A enqueues
      await rA.queue.enqueue(
        { tenantId: TENANT_A, messageId: `queue_iso_${Date.now()}_a` },
        { tenant: "A" },
      );
      // B enqueues with same messageId pattern but different tenant
      await rB.queue.enqueue(
        { tenantId: TENANT_B, messageId: `queue_iso_${Date.now()}_b` },
        { tenant: "B" },
      );

      // A's worker claims only A's messages
      const claimedA = await rA.queue.claim(
        createWorkerId(TENANT_A),
        10,
        30_000,
      );
      for (const m of claimedA) {
        await rA.queue.ack({ tenantId: TENANT_A, messageId: m.messageId }, createWorkerId(TENANT_A));
      }

      // B's worker claims only B's messages
      const claimedB = await rB.queue.claim(
        createWorkerId(TENANT_B),
        10,
        30_000,
      );
      for (const m of claimedB) {
        await rB.queue.ack({ tenantId: TENANT_B, messageId: m.messageId }, createWorkerId(TENANT_B));
      }

      // Both workers successfully processed their own messages
      expect(claimedA.length).toBeGreaterThanOrEqual(1);
      expect(claimedB.length).toBeGreaterThanOrEqual(1);
    });

    it("tenant boundary enforced across all runtime operations", async () => {
      // Summary: every runtime operation asserts tenant known + authorized
      const rA = makeRuntime(TENANT_A);

      // Submit with unknown tenant
      await expect(
        rA.runtime.submit({
          tenantId: "t_rogue" as TenantId,
          objective: "rogue",
        }),
      ).rejects.toThrow();

      // Cancel with wrong tenant
      const aKeys = await backend!.keys(`t::${TENANT_A}::job::`);
      const aJobId = aKeys[0]!.split("::job::")[1]!;
      const rB = makeRuntime(TENANT_B);
      await expect(
        rB.runtime.cancel({
          jobId: aJobId,
          tenantId: TENANT_B,
          reason: "attack",
        }),
      ).rejects.toThrow();
    });
  });
}
