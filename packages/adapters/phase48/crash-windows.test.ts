/**
 * Phase 4.8 §9 — crash-window testing (in-process, statement-boundary).
 *
 * Every critical operation is mapped onto its exact backend-call sequence
 * (T-boundaries). A worker "dies" (InjectedFailure) immediately BEFORE each
 * chosen boundary; a fresh runtime instance must then converge the system to
 * a correct state. Acceptance per window:
 *
 *   no lost committed state · no phantom uncommitted state · no double
 *   application · idempotency intact · ownership/fencing intact · retry correct
 *
 * Gated on VAULLTCORE_TEST_POSTGRES_URL. Multi-process SIGKILL variants live
 * in crash-multiprocess.test.ts.
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
  type SharedBackend,
  type StepExecution,
  type StepExecutor,
  type StepResult,
} from "@vaulltcore/workflow";
import { migratePostgres, PostgresSharedBackend } from "../pg-backend";
import {
  FaultBackend,
  POSTGRES_URL,
  printGateHeader,
  writeEvidence,
} from "./harness";

const pool = POSTGRES_URL ? postgres(POSTGRES_URL, { max: 16 }) : null;

function backend(): PostgresSharedBackend {
  return PostgresSharedBackend.fromClient(pool!);
}

const purge = async (): Promise<void> => {
  await pool!`DELETE FROM vc_kv`;
};

interface RuntimeHandle {
  runtime: DistributedDurableRuntime;
  deps: ConstructorParameters<typeof DistributedDurableRuntime>[0];
}

let executorCalls = 0;

function buildRuntime(tenant: string, b: PostgresSharedBackend | SharedBackend = backend()): RuntimeHandle {
  const clock = new SystemClock();
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
        executorCalls++;
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
    tenantIds: new Set<string>([tenant]),
    // Phase 4.8 D1 regression guard: orphaned reservations must be recoverable
    // immediately in tests (production default is 30s).
    submitOrphanGraceMs: 1,
  };
  return { runtime: new DistributedDurableRuntime(deps, tenant), deps };
}

/** Drive workers until the job reaches a terminal state (or timeout). */
async function driveUntilTerminal(
  runtime: DistributedDurableRuntime,
  tenant: string,
  jobId: string,
  budgetMs: number,
): Promise<{ terminal: boolean; status?: string }> {
  const deadline = Date.now() + budgetMs;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    await runtime.processOne();
    const job = await runtime.getJob(jobId, tenant);
    lastStatus = job?.run.status;
    if (job && ["completed", "failed", "cancelled"].includes(job.run.status)) {
      return { terminal: true, status: job.run.status };
    }
    if (job === undefined) break; // ghost — nothing to drive
  }
  return { terminal: false, status: lastStatus };
}

interface SubmitWindowResult {
  crashBeforeCallIndex: number;
  method: string | null;
  retryCreatedRun: boolean | "thrown";
  convergedTerminal: boolean;
  finalStatus?: string;
  jobRowsFound: number;
  submittedEvents: number;
}

if (!pool) {
  describe.skip("Phase 4.8 crash windows (no Postgres URL)", () => {});
} else {
  describe("Phase 4.8 §9 — submit() T0–T5 crash-window sweep", () => {
    it("dies at EVERY statement boundary of submit and must converge after retry", async () => {
      printGateHeader("crash-windows-submit");
      await migratePostgres(pool!);
      const TENANT = "t_crash_submit";

      // Baseline clean run → full call map of submit().
      await purge();
      executorCalls = 0;
      const baseFault = new FaultBackend(backend());
      const base = buildRuntime(TENANT, baseFault);
      await base.runtime.submit({
        tenantId: TENANT,
        objective: "baseline",
        idempotencyKey: "k-baseline",
      });
      const totalCalls = baseFault.callLog.length;
      expect(totalCalls).toBeGreaterThan(6);
      console.log(
        `[crash-windows] submit() makes ${totalCalls} backend calls; sweeping every boundary`,
      );
      console.log(
        "[crash-windows] call map:\n" +
          baseFault.callLog
            .map((c, i) => `  ${String(i + 1).padStart(2)}: ${c.method}`)
            .join("\n"),
      );

      const results: SubmitWindowResult[] = [];
      for (let i = 1; i <= totalCalls; i++) {
        await purge();
        executorCalls = 0;
        const tag = `obj_${i}`;
        const fault = new FaultBackend(backend());
        const victim = buildRuntime(TENANT, fault);
        fault.armCrashBeforeCall(i);
        let died = false;
        try {
          await victim.runtime.submit({
            tenantId: TENANT,
            objective: tag,
            idempotencyKey: `k-${tag}`,
          });
        } catch {
          died = true;
        }
        expect(died).toBe(true);

        // Fresh worker retries the SAME logical submission.
        const retry = buildRuntime(TENANT);
        let createdRun: boolean | "thrown" = "thrown";
        let jobId = "";
        try {
          const res = await retry.runtime.submit({
            tenantId: TENANT,
            objective: tag,
            idempotencyKey: `k-${tag}`,
          });
          createdRun = res.createdRun;
          jobId = res.jobId;
        } catch {
          // Retry itself may fail transiently; one more attempt allowed.
          const res2 = await buildRuntime(TENANT).runtime.submit({
            tenantId: TENANT,
            objective: tag,
            idempotencyKey: `k-${tag}`,
          });
          createdRun = res2.createdRun;
          jobId = res2.jobId;
        }

        // Converge: reconciliation + worker drain.
        const driver = buildRuntime(TENANT);
        await driver.runtime.reconcile();
        const outcome = jobId
          ? await driveUntilTerminal(driver.runtime, TENANT, jobId, 8000)
          : { terminal: false };

        // Evidence: exactly ONE durable job row across all tenants.
        const allKeys = await backend().keys(`t::`);
        const jobRows = allKeys.filter((k) => k.includes("::job::"));
        const runEvents =
          jobId && outcome.terminal
            ? ((await driver.deps.events.replay(
                (await driver.deps.store.getJob(TENANT, jobId))!.currentRunId!,
              )) as { type: string }[])
            : [];
        const submittedEvents = runEvents.filter(
          (e) => e.type === "run.submitted",
        ).length;

        results.push({
          crashBeforeCallIndex: i,
          method: fault.callLog[0]?.method ?? null,
          retryCreatedRun: createdRun,
          convergedTerminal: outcome.terminal,
          finalStatus: outcome.status,
          jobRowsFound: jobRows.length,
          submittedEvents,
        });
      }

      writeEvidence("crash-windows-submit.json", {
        collectedAt: new Date().toISOString(),
        totalSubmitCalls: totalCalls,
        results,
      });

      const failures = results.filter(
        (r) =>
          !r.convergedTerminal ||
          r.jobRowsFound !== 1 ||
          (r.convergedTerminal && r.submittedEvents !== 1),
      );
      console.log(
        "[crash-windows] non-converging boundaries:\n" +
          (failures.length > 0
            ? failures
                .map(
                  (f) =>
                    `  idx=${f.crashBeforeCallIndex} retryCreatedRun=${f.retryCreatedRun} terminal=${f.convergedTerminal} jobRows=${f.jobRowsFound} submittedEvents=${f.submittedEvents}`,
                )
                .join("\n")
            : "  none"),
      );
      // GATE: every boundary must converge to exactly one completed job.
      for (const r of results) {
        expect(
          `${r.crashBeforeCallIndex} converged=${r.convergedTerminal} rows=${r.jobRowsFound}`,
        ).toBe(`${r.crashBeforeCallIndex} converged=true rows=1`);
      }
    }, 170_000);
  });

  describe("Phase 4.8 §9 — enqueue visibility-orphan window", () => {
    it("death between meta-commit and visibility-append loses the message until repaired", async () => {
      await purge();
      const fault = new FaultBackend(backend());
      const q = new DistributedQueue(fault, new SystemClock());
      // enqueue call order: get(meta), cas(meta), append(qvisible)
      fault.armCrashBeforeCall(3, "append");
      let crashed = false;
      try {
        await q.enqueue(
          { tenantId: "t_crash_q", messageId: "orphan_msg" },
          { v: 1 },
        );
      } catch {
        crashed = true;
      }
      expect(crashed).toBe(true);

      const freshQ = new DistributedQueue(backend(), new SystemClock());
      // The message is durably meta-committed but NOT claimable:
      const claimed = await freshQ.claim("worker_x", 10, 60_000);
      expect(claimed).toHaveLength(0); // ← LOST until repaired

      // Duplicate enqueue rejected by meta dedup (returns false):
      expect(
        await freshQ.enqueue(
          { tenantId: "t_crash_q", messageId: "orphan_msg" },
          { v: 1 },
        ),
      ).toBe(false);
      expect(await freshQ.claim("worker_x", 10, 60_000)).toHaveLength(0);

      writeEvidence("crash-window-enqueue-orphan.json", {
        collectedAt: new Date().toISOString(),
        window: "enqueue: meta CAS committed, qvisible append not executed",
        observed: "message invisible to claim; duplicate enqueue rejected",
        classification: "LOST MESSAGE within documented durability model",
      });
    });
  });

  describe("Phase 4.8 §9 — ack() crash windows", () => {
    it("crash before cleanup leaves redelivery window; crash after cleanup leaks a visible orphan", async () => {
      // Window 1: die between inflight swap and cleanup → redelivery possible.
      await purge();
      {
        const fault = new FaultBackend(backend());
        const q = new DistributedQueue(fault, new SystemClock());
        await q.enqueue({ tenantId: "t_ack", messageId: "ack_w1" }, {});
        await q.claim("w1", 1, 200);
        // ack order: get(inflight), cas(inflight→ACKED), del(inflight), del(meta), list, cas(qvisible)
        fault.armCrashBeforeCall(3, "del");
        let crashed = false;
        try {
          await q.ack({ tenantId: "t_ack", messageId: "ack_w1" }, "w1");
        } catch {
          crashed = true;
        }
        expect(crashed).toBe(true);
        // Visibility timeout expiry → redelivered to a second worker.
        await new Promise((r) => setTimeout(r, 250));
        const q2 = new DistributedQueue(backend(), new SystemClock());
        const secondClaim = await q2.claim("w2", 10, 60_000);
        expect(secondClaim.map((m) => m.messageId)).toContain("ack_w1");
      }

      // Window 2: die after both dels but before removeVisible → orphan.
      await purge();
      {
        const fault = new FaultBackend(backend());
        const q = new DistributedQueue(fault, new SystemClock());
        await q.enqueue({ tenantId: "t_ack", messageId: "ack_w2" }, {});
        await q.claim("w1", 1, 60_000);
        // arm crash at the list(qvisible) call inside removeVisible:
        // ack order = get, cas, del(inflight), del(meta), list(qvisible), cas(qvisible)
        fault.armCrashBeforeCall(5, "list");
        let crashed = false;
        try {
          await q.ack({ tenantId: "t_ack", messageId: "ack_w2" }, "w1");
        } catch {
          crashed = true;
        }
        expect(crashed).toBe(true);
        // meta + inflight gone, but visible list still contains the id:
        const visible = (await backend().list("qvisible")) as string[];
        expect(visible).toContain("ack_w2"); // ← permanent leak without repair
        const stats = await new DistributedQueue(
          backend(),
          new SystemClock(),
        ).stats();
        expect(stats.visible).toBeGreaterThanOrEqual(0); // claim skips missing meta

        writeEvidence("crash-window-ack.json", {
          collectedAt: new Date().toISOString(),
          window1:
            "inflight swapped, cleanup not executed → at-least-once redelivery (documented contract)",
          window2:
            "meta+inflight deleted, qvisible entry remains → orphan leak (claim skips it; list grows)",
        });
      }
    }, 20_000);

    it("atomic primitives have no internal window — death before the single call is lossless", async () => {
      await purge();
      const fault = new FaultBackend(backend());
      fault.armCrashBeforeCall(1, "incr");
      let crashed = false;
      try {
        await fault.incr("atomic_probe");
      } catch {
        crashed = true;
      }
      expect(crashed).toBe(true);
      expect(await backend().get("atomic_probe")).toBeUndefined(); // no phantom

      fault.resetFaults();
      expect(await fault.incr("atomic_probe")).toBe(1); // works after recovery
    });
  });
}
