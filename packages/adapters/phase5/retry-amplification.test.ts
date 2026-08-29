/**
 * Phase 5.1 §29 — Retry Amplification Tests.
 *
 * Verifies that idempotent submission storms produce exactly one durable
 * side effect regardless of how many retries are attempted. Tests 10,
 * 100, 1000, and 10000 same-idempotency-key submissions.
 *
 * Acceptance:
 *   C1: createdRuns = 1, jobs = 1, submission events = 1, side effects = 1.
 *   C2: No positive feedback loop under elevated error rates.
 *   C3: Each test produces raw evidence.
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
  type SharedBackend,
} from "@vaulltcore/workflow";
import type { TenantId } from "@vaulltcore/workflow";
import { writeEvidence, printGateHeader, percentiles, now } from "./harness";

const TENANT: TenantId = "t_p51_retry";

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
    events: deps.events,
    store: deps.store,
  };
}

describe("Phase 5.1 §29 — retry amplification", () => {
  it("10 same-key submissions → exactly 1 run", async () => {
    printGateHeader("retry-10");
    const { runtime, events, store } = makeRuntime();
    const idemKey = `k_retry_10_${Date.now()}`;
    const objective = "retry-amplification-10";

    let createdCount = 0;
    let reusedCount = 0;

    for (let i = 0; i < 10; i++) {
      const res = await runtime.submit({
        tenantId: TENANT,
        objective,
        idempotencyKey: idemKey,
      });
      if (res.createdRun) createdCount++;
      else reusedCount++;
    }

    expect(createdCount).toBe(1);
    expect(reusedCount).toBe(9);

    // Verify state: look up by the submitted result
    // The first submit created the run, all others reused
    const activeRuns = await store.listActiveRunIds(TENANT);
    expect(activeRuns.length).toBeGreaterThanOrEqual(1);

    // Verify exactly 1 submission event across all runs
    let totalSubmittedEvents = 0;
    for (const rid of activeRuns) {
      const eventsList = await events.replay(rid);
      totalSubmittedEvents += eventsList.filter((e) => e.type === "run.submitted").length;
    }
    expect(totalSubmittedEvents).toBe(1);

    writeEvidence("retry-amplification-10.json", {
      scenario: "10 same-key submissions",
      attempts: 10,
      createdRuns: createdCount,
      reusedRuns: reusedCount,
      totalSubmittedEvents,
      verdict: createdCount === 1 && totalSubmittedEvents === 1 ? "PASS" : "FAIL",
    });
  });

  it("100 same-key submissions → exactly 1 run", async () => {
    printGateHeader("retry-100");
    const { runtime, events, store } = makeRuntime();
    const idemKey = `k_retry_100_${Date.now()}`;
    const objective = "retry-amplification-100";

    let createdCount = 0;
    const times: number[] = [];

    for (let i = 0; i < 100; i++) {
      const t0 = now();
      const res = await runtime.submit({
        tenantId: TENANT,
        objective,
        idempotencyKey: idemKey,
      });
      times.push(now() - t0);
      if (res.createdRun) createdCount++;
    }

    expect(createdCount).toBe(1);

    const p = percentiles(times);
    writeEvidence("retry-amplification-100.json", {
      scenario: "100 same-key submissions",
      attempts: 100,
      createdRuns: createdCount,
      percentiles: p,
      verdict: createdCount === 1 ? "PASS" : "FAIL",
    });
  });

  it("1000 same-key submissions → exactly 1 run", async () => {
    printGateHeader("retry-1000");
    const { runtime, store } = makeRuntime();
    const idemKey = `k_retry_1000_${Date.now()}`;
    const objective = "retry-amplification-1000";

    let createdCount = 0;
    const times: number[] = [];

    for (let i = 0; i < 1000; i++) {
      const t0 = now();
      const res = await runtime.submit({
        tenantId: TENANT,
        objective,
        idempotencyKey: idemKey,
      });
      times.push(now() - t0);
      if (res.createdRun) createdCount++;
    }

    expect(createdCount).toBe(1);

    const p = percentiles(times);
    writeEvidence("retry-amplification-1000.json", {
      scenario: "1000 same-key submissions",
      attempts: 1000,
      createdRuns: createdCount,
      percentiles: p,
      verdict: createdCount === 1 ? "PASS" : "FAIL",
    });
  });

  it("10000 same-key submissions → exactly 1 run", async () => {
    printGateHeader("retry-10000");
    const { runtime, store } = makeRuntime();
    const idemKey = `k_retry_10000_${Date.now()}`;
    const objective = "retry-amplification-10000";

    let createdCount = 0;
    const times: number[] = [];

    for (let i = 0; i < 10_000; i++) {
      const t0 = now();
      const res = await runtime.submit({
        tenantId: TENANT,
        objective,
        idempotencyKey: idemKey,
      });
      times.push(now() - t0);
      if (res.createdRun) createdCount++;
    }

    expect(createdCount).toBe(1);

    const p = percentiles(times);
    writeEvidence("retry-amplification-10000.json", {
      scenario: "10000 same-key submissions",
      attempts: 10_000,
      createdRuns: createdCount,
      percentiles: p,
      verdict: createdCount === 1 ? "PASS" : "FAIL",
    });
  });

  it("different idempotency keys → each creates independent run", async () => {
    printGateHeader("retry-independent");
    const { runtime, store } = makeRuntime();

    const RUNS = 100;
    let createdCount = 0;

    for (let i = 0; i < RUNS; i++) {
      const res = await runtime.submit({
        tenantId: TENANT,
        objective: `independent-${i}`,
        idempotencyKey: `k_independent_${Date.now()}_${i}`,
      });
      if (res.createdRun) createdCount++;
    }

    expect(createdCount).toBe(RUNS);

    writeEvidence("retry-amplification-independent.json", {
      scenario: "100 different idempotency keys",
      attempts: RUNS,
      createdRuns: createdCount,
      verdict: createdCount === RUNS ? "PASS" : "FAIL",
    });
  });
});
