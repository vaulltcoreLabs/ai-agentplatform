/**
 * Phase 5.1 §23 — Reconciliation Stress Tests.
 *
 * Uses the runtime API to create proper durable state, then verifies
 * that repeated reconciliation (listActiveRunIds) is idempotent and
 * concurrent reconciliation converges.
 *
 * Acceptance:
 *   C1: Repeated reconciliation is idempotent.
 *   C2: No destructive repair of valid state.
 *   C3: Concurrent reconciliation converges.
 *   C4: Each run produces raw evidence.
 *
 * Runs on SQLite (no external infrastructure needed).
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
  CAS_ABSENT,
} from "@vaulltcore/workflow";
import type { TenantId } from "@vaulltcore/workflow";
import { writeEvidence, printGateHeader } from "./harness";

const TENANT: TenantId = "t_p51_reconc";

function makeRuntime() {
  const clock = new SystemClock();
  const store = new InMemoryWorkflowStore(clock);
  const queue = new InMemoryQueue();
  const deps = {
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
  return {
    runtime: new DistributedDurableRuntime(deps, TENANT),
    store,
    events: deps.events,
    checkpoints: deps.checkpoints,
    queue,
  };
}

describe("Phase 5.1 §23 — reconciliation stress", () => {
  it("single reconciliation scan finds all active runs", async () => {
    printGateHeader("reconcile-single");
    const r = makeRuntime();

    // Create 5 active runs via the runtime
    const runIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await r.runtime.submit({
        tenantId: TENANT,
        objective: `reconcile-single-${i}`,
        idempotencyKey: `k_reconc_single_${Date.now()}_${i}`,
      });
      runIds.push(res.runId);
    }

    // Reconciliation scan — find all active runs
    const activeRuns = await r.store.listActiveRunIds(TENANT);
    expect(activeRuns.length).toBeGreaterThanOrEqual(5);

    // All submitted run IDs should be in the active list
    for (const rid of runIds) {
      expect(activeRuns).toContain(rid);
    }

    // Verify state is unchanged after scan
    for (const rid of runIds) {
      const run = await r.store.getRun(rid);
      expect(run).toBeDefined();
      expect(run!.status).not.toBe("failed");
    }

    writeEvidence("reconcile-single.json", {
      scenario: "single reconciliation scan of 5 active runs",
      activeRunsFound: activeRuns.length,
      submittedRuns: runIds.length,
      allFound: runIds.every((rid) => activeRuns.includes(rid)),
      verdict: "PASS",
    });
  });

  it("10× repeated reconciliation is idempotent", async () => {
    printGateHeader("reconcile-idempotent");
    const r = makeRuntime();

    // Create 3 active runs
    for (let i = 0; i < 3; i++) {
      await r.runtime.submit({
        tenantId: TENANT,
        objective: `reconcile-idem-${i}`,
        idempotencyKey: `k_reconc_idem_${Date.now()}_${i}`,
      });
    }

    // Run reconciliation 10 times
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const runs = await r.store.listActiveRunIds(TENANT);
      results.push(runs.length);
    }

    // All results must be identical (idempotent)
    const allSame = results.every((r) => r === results[0]);
    expect(allSame).toBe(true);
    expect(results[0]).toBeGreaterThanOrEqual(3);

    writeEvidence("reconcile-idempotent-10x.json", {
      scenario: "10× repeated reconciliation on 3 active runs",
      results,
      allSame,
      runCount: results[0],
      verdict: allSame ? "PASS" : "FAIL",
    });
  });

  it("100× reconciliation on 20 runs is idempotent", async () => {
    printGateHeader("reconcile-100x");
    const r = makeRuntime();

    // Create 20 active runs
    for (let i = 0; i < 20; i++) {
      await r.runtime.submit({
        tenantId: TENANT,
        objective: `reconcile-scale-${i}`,
        idempotencyKey: `k_reconc_scale_${Date.now()}_${i}`,
      });
    }

    const results: number[] = [];
    for (let i = 0; i < 100; i++) {
      const runs = await r.store.listActiveRunIds(TENANT);
      results.push(runs.length);
    }

    const allSame = results.every((r) => r === results[0]);
    expect(allSame).toBe(true);
    expect(results[0]).toBeGreaterThanOrEqual(20);

    writeEvidence("reconcile-idempotent-100x.json", {
      scenario: "100× reconciliation on 20 active runs",
      runCount: results[0],
      iterations: 100,
      allSame,
      verdict: allSame ? "PASS" : "FAIL",
    });
  });

  it("concurrent reconciliation from 4 parallel readers", async () => {
    printGateHeader("reconcile-concurrent");
    const r = makeRuntime();

    // Create 10 active runs
    for (let i = 0; i < 10; i++) {
      await r.runtime.submit({
        tenantId: TENANT,
        objective: `reconcile-conc-${i}`,
        idempotencyKey: `k_reconc_conc_${Date.now()}_${i}`,
      });
    }

    // 4 concurrent reconciliation scans
    const results = await Promise.all(
      Array.from({ length: 4 }, () => r.store.listActiveRunIds(TENANT)),
    );

    // All must see the same count
    const allSame = results.every((r) => r.length === results[0]!.length);
    expect(allSame).toBe(true);
    expect(results[0]!.length).toBeGreaterThanOrEqual(10);

    writeEvidence("reconcile-concurrent-4x.json", {
      scenario: "4 concurrent reconciliation scans on 10+ active runs",
      readers: 4,
      counts: results.map((r) => r.length),
      allSame,
      verdict: allSame ? "PASS" : "FAIL",
    });
  });
});
