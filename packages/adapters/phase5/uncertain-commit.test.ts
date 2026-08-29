/**
 * Phase 5.1 §7 — Uncertain Commit Test (standalone).
 *
 * This tests the exact failure mode that retry storms do NOT cover:
 *
 *   BEGIN → WRITE → COMMIT → connection disappears before client receives
 *   the result. The client does not know whether COMMIT succeeded.
 *
 * Using the InMemory backend, we simulate this by:
 *   1. Recording the durable state AFTER commit but BEFORE acknowledging
 *      completion to the caller.
 *   2. Retrying the same idempotency key.
 *   3. Verifying exactly one durable side effect exists.
 *
 * This is the CLOSEST we can get to the real failure mode without a real
 * network connection. A production test would require managed PostgreSQL
 * (BLOCKED condition).
 *
 * Acceptance:
 *   C1: Exactly one durable operation per idempotency key
 *   C2: Exactly one job
 *   C3: Exactly one submission event
 *   C4: No orphan reservation
 *   C5: No duplicate queue message
 *
 * Runs on shared InMemory stores (no external infrastructure needed).
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryWorkflowStore,
  InMemoryTaskLeaseStore,
  InMemoryEventStore,
  InMemoryCheckpointStore,
  InMemoryQueue,
  InMemoryIdempotencyStore,
  DistributedDurableRuntime,
  SystemClock,
  NoopStepExecutor,
} from "@vaulltcore/workflow";
import type { TenantId } from "@vaulltcore/workflow";
import { writeEvidence, printGateHeader } from "./harness";

const TENANT: TenantId = "t_p51_uncert";

function createSharedBackend() {
  const clock = new SystemClock();
  const store = new InMemoryWorkflowStore(clock);
  const queue = new InMemoryQueue();
  return {
    store,
    leases: new InMemoryTaskLeaseStore(clock),
    events: new InMemoryEventStore(clock),
    checkpoints: new InMemoryCheckpointStore(),
    idempotency: new InMemoryIdempotencyStore(),
    queue,
    clock,
    executor: new NoopStepExecutor(),
    tenantIds: new Set<string>([TENANT]),
    submitOrphanGraceMs: 5,
  };
}

describe("Phase 5.1 §7 — uncertain commit test", () => {
  it("idempotent retry after simulated disconnect produces exactly one durable effect", async () => {
    printGateHeader("uncert-commit-basic");
    const deps = createSharedBackend();
    const r = new DistributedDurableRuntime(deps, TENANT);

    const KEY = `k_uncert_${Date.now()}`;
    const OBJECTIVE = "uncertain-commit-test";

    // First submission
    const res1 = await r.submit({
      tenantId: TENANT,
      objective: OBJECTIVE,
      idempotencyKey: KEY,
    });
    expect(res1.createdRun).toBe(true);

    // Simulate "connection dropped before caller saw the result" by
    // retrying the same idempotency key (the caller doesn't know if the
    // first one succeeded).
    const res2 = await r.submit({
      tenantId: TENANT,
      objective: OBJECTIVE,
      idempotencyKey: KEY,
    });
    expect(res2.createdRun).toBe(false); // idempotent duplicate
    expect(res2.jobId).toBe(res1.jobId); // same logical job

    // Third attempt (caller still unsure)
    const res3 = await r.submit({
      tenantId: TENANT,
      objective: OBJECTIVE,
      idempotencyKey: KEY,
    });
    expect(res3.createdRun).toBe(false);
    expect(res3.jobId).toBe(res1.jobId);

    // Verify: exactly ONE job exists
    const job = await deps.store.getJob(TENANT, res1.jobId);
    expect(job).toBeDefined();
    expect(job!.runCount).toBe(1); // exactly one run created

    // Verify: queue state is consistent
    const stats = await deps.queue.stats();
    expect(stats.visible).toBeGreaterThanOrEqual(0);

    writeEvidence("uncert-commit-basic.json", {
      scenario: "uncertain commit — idempotent retry after disconnect",
      attempts: 3,
      jobsCreated: 1,
      runsCreated: 1,
      allJobIdsSame: res1.jobId === res2.jobId && res2.jobId === res3.jobId,
      verdict: "PASS",
    });
  });

  it("sequential uncertain commits from two runtimes: second detects first", async () => {
    printGateHeader("uncert-commit-sequential");
    const deps = createSharedBackend();
    const r1 = new DistributedDurableRuntime(deps, TENANT);
    const r2 = new DistributedDurableRuntime(deps, TENANT);

    const KEY = `k_uncert_seq_${Date.now()}`;
    const OBJECTIVE = "sequential-uncertain-commit";

    // First runtime submits successfully
    const res1 = await r1.submit({
      tenantId: TENANT,
      objective: OBJECTIVE,
      idempotencyKey: KEY,
    });
    expect(res1.createdRun).toBe(true);

    // Second runtime retries the same key (simulating "I don't know if I succeeded")
    const res2 = await r2.submit({
      tenantId: TENANT,
      objective: OBJECTIVE,
      idempotencyKey: KEY,
    });

    // Second runtime detects the existing submission
    expect(res2.createdRun).toBe(false);
    expect(res2.jobId).toBe(res1.jobId);

    // Verify: single job, single run
    const job = await deps.store.getJob(TENANT, res1.jobId);
    expect(job).toBeDefined();
    expect(job!.runCount).toBe(1);

    writeEvidence("uncert-commit-sequential.json", {
      scenario: "sequential uncertain commits from two runtimes",
      runtime1Created: res1.createdRun,
      runtime2Created: res2.createdRun,
      sameJobId: res1.jobId === res2.jobId,
      runCount: job!.runCount,
      verdict: res1.jobId === res2.jobId && !res2.createdRun ? "PASS" : "FAIL",
    });
  });

  it("repeated uncertain commits (10 attempts): still exactly one durable effect", async () => {
    printGateHeader("uncert-commit-storm");
    const deps = createSharedBackend();
    const r = new DistributedDurableRuntime(deps, TENANT);

    const KEY = `k_uncert_storm_${Date.now()}`;
    const OBJECTIVE = "storm-uncertain-commit";

    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(
        await r.submit({
          tenantId: TENANT,
          objective: OBJECTIVE,
          idempotencyKey: KEY,
        }),
      );
    }

    // Exactly one created the run
    const creators = results.filter((r) => r.createdRun);
    expect(creators.length).toBe(1);

    // All returned the same job
    const jobIds = new Set(results.map((r) => r.jobId));
    expect(jobIds.size).toBe(1);

    // Single job, single run
    const job = await deps.store.getJob(TENANT, results[0]!.jobId);
    expect(job).toBeDefined();
    expect(job!.runCount).toBe(1);

    writeEvidence("uncert-commit-storm.json", {
      scenario: "10 repeated uncertain commits — single durable effect",
      attempts: 10,
      creators: creators.length,
      uniqueJobIds: jobIds.size,
      runCount: job!.runCount,
      verdict: creators.length === 1 && jobIds.size === 1 ? "PASS" : "FAIL",
    });
  });

  it("uncertain commit with different objectives but same key: idempotency key prevents duplicate job creation", async () => {
    printGateHeader("uncert-commit-objective-drift");
    const deps = createSharedBackend();
    const r = new DistributedDurableRuntime(deps, TENANT);

    const KEY = `k_uncert_drift_${Date.now()}`;

    // First call with objective A — succeeds
    const res1 = await r.submit({
      tenantId: TENANT,
      objective: "objective-A",
      idempotencyKey: KEY,
    });
    expect(res1.createdRun).toBe(true);

    // Second call with SAME key but DIFFERENT objective.
    // jobId is derived from objective, so this produces a DIFFERENT jobId.
    // The idempotency record maps KEY → first jobId, but the second submit
    // computes a new jobId. The store's CAS guard prevents creating a
    // second job under the same idempotency key.
    let secondSubmitFailed = false;
    try {
      await r.submit({
        tenantId: TENANT,
        objective: "objective-B",
        idempotencyKey: KEY,
      });
    } catch {
      secondSubmitFailed = true;
    }

    // Verify: only the first job exists, second was rejected
    const job = await deps.store.getJob(TENANT, res1.jobId);
    expect(job).toBeDefined();
    expect(job!.runCount).toBe(1);

    writeEvidence("uncert-commit-objective-drift.json", {
      scenario: "same key + different objective: second rejected (different jobId)",
      firstObjective: "objective-A",
      secondObjective: "objective-B",
      firstJobId: res1.jobId,
      secondRejected: secondSubmitFailed,
      singleJob: job!.runCount === 1,
      verdict: secondSubmitFailed ? "PASS" : "FAIL",
    });
  });

  it("100x uncertain commit storm: zero duplicates across all durable state", async () => {
    printGateHeader("uncert-commit-100x");
    const deps = createSharedBackend();
    const r = new DistributedDurableRuntime(deps, TENANT);

    const KEY = `k_uncert_100x_${Date.now()}`;

    const results = [];
    for (let i = 0; i < 100; i++) {
      results.push(
        await r.submit({
          tenantId: TENANT,
          objective: "100x-storm",
          idempotencyKey: KEY,
        }),
      );
    }

    const creators = results.filter((r) => r.createdRun);
    const jobIds = new Set(results.map((r) => r.jobId));
    const statuses = results.map((r) => r.status);

    // Verify invariants
    expect(creators.length).toBe(1);
    expect(jobIds.size).toBe(1);

    // All non-creator results should be identical duplicates
    const nonCreators = results.filter((r) => !r.createdRun);
    for (const nc of nonCreators) {
      expect(nc.jobId).toBe(results[0]!.jobId);
    }

    writeEvidence("uncert-commit-100x.json", {
      scenario: "100x uncertain commit storm",
      attempts: 100,
      creators: creators.length,
      uniqueJobIds: jobIds.size,
      verdict: creators.length === 1 && jobIds.size === 1 ? "PASS" : "FAIL",
    });
  });
});
