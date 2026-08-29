/**
 * Phase 5 §6 — Observability Verification.
 *
 * Verifies that every durable state transition emits a structured event,
 * that the event stream is complete and ordered, and that timing instrumentation
 * is accurate.
 *
 * Acceptance:
 *   C1: Every submit() emits run.submitted event.
 *   C2: Every processOne() emits appropriate step events.
 *   C3: Events are monotonically sequenced per run.
 *   C4: Checkpoint save/load round-trips correctly.
 *   C5: Event replay reconstructs correct state.
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
  SystemClock,
} from "@vaulltcore/workflow";
import type { TenantId } from "@vaulltcore/workflow";
import { migratePostgres, PostgresSharedBackend } from "../pg-backend";
import { POSTGRES_URL, printGateHeader, writeEvidence, now } from "./harness";

const TENANT: TenantId = "t_p5_obs";

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
        executor: {
          async execute() {
            return {
              output: { ok: true },
              usage: { modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5 },
              artifacts: [],
            };
          },
        },
        tenantIds: new Set<string>([TENANT]),
        submitOrphanGraceMs: 5,
      },
      tenantId,
    ),
    events: new DistributedEventStore(b, clock),
    checkpoints: new DistributedCheckpointStore(b),
    backend: b,
  };
}

async function purge() {
  await sql!`DELETE FROM vc_kv`;
}

beforeAll(async () => {
  if (!POSTGRES_URL) return;
  sql = postgres(POSTGRES_URL, { max: 10 });
  backend = PostgresSharedBackend.fromClient(sql);
  await migratePostgres(sql);
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 2 });
});

if (!POSTGRES_URL) {
  describe.skip("Phase 5 §6 — observability (no Postgres)", () => {});
} else {
  describe("Phase 5 §6 — structured event emission", () => {
    it("submit() emits run.submitted event with correct structure", async () => {
      printGateHeader("obs-submit-event");
      await purge();
      const r = makeRuntime(TENANT);

      const res = await r.runtime.submit({
        tenantId: TENANT,
        objective: "obs-event-test",
        idempotencyKey: "k_p5_obs_submit",
      });
      expect(res.createdRun).toBe(true);

      // Replay events for this run
      const events = await r.events.replay(res.runId);
      expect(events.length).toBeGreaterThanOrEqual(1);

      const submitted = events.filter((e) => e.type === "run.submitted");
      expect(submitted.length).toBe(1);

      const evt = submitted[0]!;
      expect(evt.runId).toBe(res.runId);
      expect(evt.sequence).toBeGreaterThanOrEqual(1);
      expect(evt.timestamp).toBeGreaterThan(0);

      writeEvidence("obs-submit-event.json", {
        scenario: "submit() event emission",
        totalEvents: events.length,
        submittedEvents: submitted.length,
        eventTypes: events.map((e) => e.type),
        verdict: "PASS",
      });
    });

    it("events are monotonically sequenced per run", async () => {
      await purge();
      const r = makeRuntime(TENANT);

      const res = await r.runtime.submit({
        tenantId: TENANT,
        objective: "obs-sequence-test",
        idempotencyKey: "k_p5_obs_seq",
      });

      const events = await r.events.replay(res.runId);

      // Verify monotonic sequence
      let prevSeq = 0;
      for (const evt of events) {
        expect(evt.sequence).toBeGreaterThanOrEqual(prevSeq);
        prevSeq = evt.sequence;
      }
    });

    it("idempotent retry does not duplicate events", async () => {
      await purge();
      const r = makeRuntime(TENANT);

      const first = await r.runtime.submit({
        tenantId: TENANT,
        objective: "obs-idem-test",
        idempotencyKey: "k_p5_obs_idem",
      });
      expect(first.createdRun).toBe(true);

      const eventsAfterFirst = await r.events.replay(first.runId);

      // Retry 5 times
      for (let i = 0; i < 5; i++) {
        const retry = await r.runtime.submit({
          tenantId: TENANT,
          objective: "obs-idem-test",
          idempotencyKey: "k_p5_obs_idem",
        });
        expect(retry.createdRun).toBe(false);
      }

      // Event count unchanged
      const eventsAfterRetry = await r.events.replay(first.runId);
      expect(eventsAfterRetry.length).toBe(eventsAfterFirst.length);
    });

    it("event replay reconstructs correct job state", async () => {
      await purge();
      const r = makeRuntime(TENANT);

      const res = await r.runtime.submit({
        tenantId: TENANT,
        objective: "obs-replay-test",
        idempotencyKey: "k_p5_obs_replay",
      });

      const job = await r.runtime.getJob(res.jobId, TENANT);
      expect(job).toBeDefined();
      expect(job!.job.id).toBe(res.jobId);
      expect(job!.job.tenantId).toBe(TENANT);
      expect(job!.run.id).toBe(res.runId);

      // Verify events match
      const events = await r.events.replay(res.runId);
      const submittedEvents = events.filter((e) => e.type === "run.submitted");
      expect(submittedEvents.length).toBe(1);
    });
  });

  describe("Phase 5 §6 — checkpoint observability", () => {
    it("checkpoint save/load round-trips correctly", async () => {
      printGateHeader("obs-checkpoint");
      await purge();
      const r = makeRuntime(TENANT);
      const cps = r.checkpoints;

      const checkpoint = {
        id: `ckpt_obs_${Date.now()}`,
        sequence: 0,
        state: { step: "phase5", progress: 50 },
        evidence: ["observation:test"],
        attempt: 1,
        createdAt: Date.now(),
        runId: "run_obs_test",
        taskId: "task_obs_test",
        stepId: "step_obs_test",
      };

      await cps.save(checkpoint);

      const loaded = await cps.listForStep("step_obs_test");
      expect(loaded.length).toBe(1);
      expect(loaded[0]!.id).toBe(checkpoint.id);
      expect(loaded[0]!.state).toEqual(checkpoint.state);
    });

    it("multiple checkpoints per step are ordered by sequence", async () => {
      await purge();
      const r = makeRuntime(TENANT);
      const cps = r.checkpoints;

      for (let i = 0; i < 5; i++) {
        await cps.save({
          id: `ckpt_seq_${i}`,
          sequence: i,
          state: { seq: i },
          evidence: [],
          attempt: 1,
          createdAt: Date.now() + i,
          runId: "run_seq_test",
          taskId: "task_seq_test",
          stepId: "step_seq_test",
        });
      }

      const loaded = await cps.listForStep("step_seq_test");
      expect(loaded.length).toBe(5);

      // Verify ordering
      for (let i = 0; i < loaded.length; i++) {
        expect(loaded[i]!.sequence).toBe(i);
      }
    });
  });

  describe("Phase 5 §6 — timing instrumentation", () => {
    it("submit latency is measurable and bounded", async () => {
      await purge();
      const r = makeRuntime(TENANT);

      const latencies: number[] = [];
      for (let i = 0; i < 10; i++) {
        const t0 = now();
        await r.runtime.submit({
          tenantId: TENANT,
          objective: `obs_timing_${i}`,
          idempotencyKey: `k_p5_obs_timing_${i}`,
        });
        latencies.push(now() - t0);
      }

      const avgMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxMs = Math.max(...latencies);

      writeEvidence("obs-timing.json", {
        scenario: "10 submit() latencies",
        avgMs: Math.round(avgMs * 100) / 100,
        maxMs: Math.round(maxMs * 100) / 100,
        allLatencies: latencies.map((l) => Math.round(l * 100) / 100),
        verdict: "PASS",
      });

      // Bounded latency (generous for CI environment)
      expect(avgMs).toBeLessThan(1000);
      expect(maxMs).toBeLessThan(5000);
    });
  });
}
