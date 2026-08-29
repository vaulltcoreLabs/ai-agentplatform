/**
 * Phase 4.8 — child worker process for TRUE multi-process experiments.
 *
 * Runs as its own OS process (`bun packages/adapters/phase48/child-worker.ts`)
 * so parent suites can measure real multi-process topology (§3), kill it with
 * SIGKILL at exact durable boundaries (§9), and collect per-interval summaries
 * for ladder/soak aggregation (§5–§7).
 *
 * Every durable boundary emits a synchronous trace line (appendFileSync) BEFORE
 * the crash decision, so a parent can verify exactly how far a killed process
 * got. SIGKILL is used because it is uncatchable — identical to `kill -9`.
 */

import { appendFileSync } from "node:fs";
import postgres from "postgres";
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
} from "@vaulltcore/workflow";
import { PostgresSharedBackend } from "../pg-backend";

const URL_ = process.env.VAULLTCORE_TEST_POSTGRES_URL ?? "";
const TRACE_FILE = process.env.CHILD_TRACE_FILE ?? "";
const MODE = process.env.CHILD_MODE ?? "";
const WORKER_ID = process.env.CHILD_WORKER_ID ?? `child_${process.pid}`;
const TENANT = process.env.CHILD_TENANT ?? "tenant_p48_child";
const CRASH_AT = process.env.CHILD_CRASH_AT ?? "";

function trace(boundary: string, data: Record<string, unknown> = {}): void {
  if (!TRACE_FILE) return;
  appendFileSync(
    TRACE_FILE,
    `${JSON.stringify({ pid: process.pid, at: Date.now(), boundary, ...data })}\n`,
  );
}

function dieIf(boundary: string): void {
  if (CRASH_AT === boundary) {
    trace("sigkill", { crashedAt: boundary });
    process.kill(process.pid, "SIGKILL");
  }
}

function makePool(max: number): postgres.Sql {
  const u = new URL(URL_);
  return postgres({
    host: u.hostname || "127.0.0.1",
    port: Number(u.port || 5432),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    max,
  });
}

/**
 * Executor used by crash-window children.
 *
 * Contractual mode (default): consults the IdempotencyStore before performing
 * an externally-visible side effect — exactly what StepExecution.idempotencyKey
 * documents executors SHOULD do. NAIVE mode (CHILD_NAIVE_EXECUTOR=1) skips the
 * check to expose raw at-least-once behavior for comparison.
 */
function buildExecutor(
  backend: PostgresSharedBackend,
  idem: DistributedIdempotencyStore | null,
): StepExecutor {
  return {
    async execute(e: StepExecution, _s: AbortSignal): Promise<StepResult> {
      const effectKey = `effect::${e.idempotencyKey}`;
      if (idem && !process.env.CHILD_NAIVE_EXECUTOR) {
        const verdict = await idem.record(effectKey, "side-effect", {
          stepId: e.step.id,
        });
        if (verdict !== "recorded") {
          return {
            output: { deduplicated: true },
            usage: {
              modelCalls: 0,
              toolCalls: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
            artifacts: [],
          };
        }
      }
      // The externally-visible side effect: one appended entry per execution.
      await backend.append(`sideeffects::${e.step.runId}`, {
        stepId: e.step.id,
        attempt: e.step.attempt,
        at: Date.now(),
      });
      await sleep(5);
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
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface WorkerDepsFull {
  store: DistributedWorkflowStore;
  leases: DistributedTaskLeaseStore;
  events: DistributedEventStore;
  checkpoints: DistributedCheckpointStore;
  idempotency: DistributedIdempotencyStore;
  queue: DistributedQueue;
  clock: SystemClock;
  executor: StepExecutor;
}

function buildDeps(pool: postgres.Sql): WorkerDepsFull {
  const clock = new SystemClock();
  const b = PostgresSharedBackend.fromClient(pool);
  const idempotency = new DistributedIdempotencyStore(b);
  const deps: WorkerDepsFull = {
    store: new DistributedWorkflowStore(b, clock),
    leases: new DistributedTaskLeaseStore(b, clock),
    events: new DistributedEventStore(b, clock),
    checkpoints: new DistributedCheckpointStore(b),
    idempotency,
    queue: new DistributedQueue(b, clock),
    clock,
    executor: buildExecutor(b, idempotency),
  };
  return deps;
}

// ---------------------------------------------------------------------------
// MODE: queue-life — full queue lifecycle with observable side effects and
// SIGKILL boundaries between every durable transition.
// ---------------------------------------------------------------------------

async function runQueueLife(): Promise<void> {
  const pool = makePool(4);
  try {
    const b = PostgresSharedBackend.fromClient(pool);
    const q = new DistributedQueue(b, new SystemClock());
    const msgId = process.env.CHILD_MSG_ID ?? `crashmsg_${WORKER_ID}`;

    trace("start", { msgId });
    const enqueued = await q.enqueue(
      { tenantId: TENANT, messageId: msgId },
      { n: 1 },
      { delayMs: 0 },
    );
    trace("enqueued", { enqueued });
    dieIf("enqueued");

    const claimed = await q.claim(WORKER_ID, 1, 60_000);
    trace("claimed", { count: claimed.length });
    dieIf("claimed");
    if (claimed.length === 0) {
      trace("nothing-claimed");
      return;
    }

    // Externally-visible side effect (the thing at-least-once threatens).
    const effectsKey = `sideeffects${"::"}${msgId}`;
    await b.append(effectsKey, { by: WORKER_ID, at: Date.now() });
    trace("executed");
    dieIf("executed");

    // Checkpoint (durable progress marker).
    const cps = new DistributedCheckpointStore(b);
    const existing = await cps.listForStep(msgId);
    await cps.save({
      id: `ckpt_${msgId}_${existing.length}`,
      sequence: existing.length,
      state: { done: true },
      evidence: [],
      attempt: 1,
      createdAt: Date.now(),
      runId: "n/a",
      taskId: "n/a",
      stepId: msgId,
    });
    trace("checkpointed");
    dieIf("checkpointed");

    // Commit: CAS-guarded completion marker (fencing stand-in).
    for (;;) {
      const cur = (await b.get(`commit${"::"}${msgId}`)) as
        | { n: number }
        | undefined;
      if (
        await b.cas(`commit${"::"}${msgId}`, cur ?? CAS_ABSENT, {
          n: (cur?.n ?? 0) + 1,
        })
      )
        break;
    }
    trace("committed");
    dieIf("committed");

    await q.ack({ tenantId: TENANT, messageId: msgId }, WORKER_ID);
    trace("acked");
  } finally {
    await pool.end({ timeout: 1 });
  }
}

// ---------------------------------------------------------------------------
// MODE: submit — runtime.submit with SIGKILL boundaries across its statement
// sequence (idem-record → job → run → tasks → event → enqueue → return).
// ---------------------------------------------------------------------------

async function runSubmit(): Promise<void> {
  const pool = makePool(4);
  try {
    const deps = buildDeps(pool);
    const runtime = new DistributedDurableRuntime(
      {
        ...deps,
        tenantIds: new Set<string>([TENANT]),
      },
      TENANT,
    );
    const objective = process.env.CHILD_OBJECTIVE ?? "crash-submit";
    const key = process.env.CHILD_IDEM_KEY ?? "";
    trace("start");
    const res = await runtime.submit({
      tenantId: TENANT,
      objective,
      ...(key ? { idempotencyKey: key } : {}),
    });
    trace("submitted", { ...res } as Record<string, unknown>);
    dieIf("returned");
  } finally {
    await pool.end({ timeout: 1 });
  }
}

// ---------------------------------------------------------------------------
// MODE: ladder / soak — mixed workload loop emitting per-interval summaries.
// ---------------------------------------------------------------------------

interface IntervalSummary {
  workerId: string;
  pid: number;
  ts: number;
  intervalMs: number;
  ops: number;
  failures: number;
  retries: number;
  casConflicts: number;
  samplesMs: number[];
}

async function runLoadLoop(): Promise<void> {
  const durationMs = Number(process.env.CHILD_DURATION_MS ?? "15000");
  const intervalMs = Number(process.env.CHILD_INTERVAL_MS ?? "1000");
  const resultFile = process.env.CHILD_RESULT_FILE ?? "";
  const poolMax = Number(process.env.CHILD_POOL_MAX ?? "8");
  const pool = makePool(poolMax);
  const stopAt = Date.now() + durationMs;
  try {
    const b = PostgresSharedBackend.fromClient(pool);
    const q = new DistributedQueue(b, new SystemClock());
    let ops = 0;
    let failures = 0;
    let retries = 0;
    let casConflicts = 0;
    let samples: number[] = [];
    let windowStart = Date.now();

    const flush = (): void => {
      if (!resultFile) return;
      const summary: IntervalSummary = {
        workerId: WORKER_ID,
        pid: process.pid,
        ts: Date.now(),
        intervalMs: Date.now() - windowStart,
        ops,
        failures,
        retries,
        casConflicts,
        samplesMs: samples.splice(0).map((x) => Math.round(x * 100) / 100),
      };
      appendFileSync(resultFile, `${JSON.stringify(summary)}\n`);
      ops = 0;
      failures = 0;
      retries = 0;
      casConflicts = 0;
      windowStart = Date.now();
    };

    const timer = setInterval(flush, intervalMs);

    while (Date.now() < stopAt) {
      const t0 = performance.now();
      try {
        const kind = ops % 4;
        if (kind === 0) {
          await b.incr(`${TENANT}${"::"}load_ctr`);
        } else if (kind === 1) {
          for (;;) {
            const cur = (await b.get(`${TENANT}${"::"}load_cas`)) as
              | { n: number }
              | undefined;
            if (
              await b.cas(`${TENANT}${"::"}load_cas`, cur ?? CAS_ABSENT, {
                n: (cur?.n ?? 0) + 1,
              })
            )
              break;
            casConflicts++;
          }
        } else if (kind === 2) {
          await b.append(`${TENANT}${"::"}load_events`, { at: Date.now() });
        } else {
          const id = `${TENANT}${"::"}q_${Date.now().toString(36)}_${ops}`;
          if (await q.enqueue({ tenantId: TENANT, messageId: id }, {})) {
            const got = await q.claim(WORKER_ID, 1, 30_000);
            for (const m of got)
              await q.ack(
                { tenantId: TENANT, messageId: m.messageId },
                WORKER_ID,
              );
          }
        }
        ops++;
      } catch {
        failures++;
        retries++;
      }
      samples.push(performance.now() - t0);
    }
    clearInterval(timer);
    flush();
    trace("done");
  } finally {
    await pool.end({ timeout: 1 });
  }
}

// ---------------------------------------------------------------------------

const modes: Record<string, () => Promise<void>> = {
  "queue-life": runQueueLife,
  submit: runSubmit,
  load: runLoadLoop,
};

const run = modes[MODE];
if (!run) {
  console.error(`unknown CHILD_MODE=${MODE}`);
  process.exit(2);
}
run()
  .then(() => process.exit(0))
  .catch((err) => {
    trace("error", {
      message: String((err as Error)?.message ?? err).slice(0, 200),
    });
    process.exit(1);
  });
