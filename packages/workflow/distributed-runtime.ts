/**
 * Vaulltcore Durable Execution — distributed durable runtime.
 *
 * This is the Phase 4.1 production runtime. It implements `WorkflowRuntime`
 * over the provider-neutral contracts and is constructed against a *shared*
 * backend (via `Distributed*` stores), so multiple instances — Runtime A and
 * Runtime B — coordinate through durable state rather than in-memory maps.
 *
 * Lifecycle (real queue dispatch, F-9/F-11):
 *
 *   submit()  → validate auth + objective
 *            → atomic idempotency check (F-2)
 *            → persist job + run + DAG tasks (F-7)
 *            → set run deadline (budget, F-5)
 *            → enqueue a work message (real queue)
 *            → return immediately
 *
 *    workers  → poll queue → releaseSteps (scheduler) → execute → checkpoint
 *              (F-4) → commit fenced by lease (F-1) → ack queue
 *
 * Cancellation (F-3) is a durable marker written by `cancel()` and observed by
 * workers on every poll, so a cancellation initiated on Runtime A stops work
 * running on Runtime B.
 *
 * The existing single-process `DurableWorkflowRuntime` remains available for
 * local/test use; this class is the one intended for distributed deployment.
 */

import type {
  DurableJobId,
  DurableRunId,
  TenantId,
  WorkerId,
} from "./identity";
import {
  createDurableJobId,
  createDurableRunId,
  createWorkerId,
  idemKey,
} from "./identity";
import type {
  JobState,
  SubmitRequest,
  SubmitResult,
  CancelRequest,
  CancelResult,
  DurableEvent,
  Queue,
} from "./contracts";
import type { ExecutionPolicy } from "@vaulltcore/intelligence";
import {
  DEFAULT_EXECUTION_POLICY,
  applyPolicyOverride,
} from "@vaulltcore/intelligence";
import { isTerminal } from "./status";
import type { Run, Job, RunBudget } from "./model";
import { computeRunDeadline } from "./deadlines";
import { validateObjective, redactObjective, redactDurableEvent } from "./security";
import {
  assertAuthorized,
  assertTenantKnown,
  AuthorizationError,
} from "./authorization";
import { planDag, validateDag, type DagSpec } from "./dag";
import { DurableWorker, type WorkerDeps } from "./worker";
import { encodeCursor } from "./streaming";

export interface DistributedRuntimeDeps extends WorkerDeps {
  readonly tenantIds: ReadonlySet<string>;
  readonly policy?: ExecutionPolicy;
  /** DAG to plan for each submitted job. Defaults to a single "main" task. */
  readonly dag?: DagSpec;
  /**
   * Phase 4.8 (crash-window finding D1): how long an idempotency reservation
   * with INCOMPLETE durable state is treated as "original submitter still in
   * flight" before another runtime may re-materialize it. Default 30s.
   */
  readonly submitOrphanGraceMs?: number;
}

const DEFAULT_ORPHAN_GRACE_MS = 30_000;
/**
 * Hard upper bound on how long a duplicate submit() will WAIT for an original
 * to complete before recovering the orphan itself (safe: replay-safe writes).
 * Prevents unbounded caller latency regardless of configured grace.
 */
const COURTESY_WAIT_MS = 250;

const DEFAULT_DAG: DagSpec = {
  nodes: [{ name: "main", specialist: "default", dependsOn: [], input: {} }],
};

export class DistributedDurableRuntime {
  private readonly worker: DurableWorker;
  private readonly policy: ExecutionPolicy;
  private readonly dag: DagSpec;
  private readonly workerId: WorkerId;

  constructor(
    private readonly deps: DistributedRuntimeDeps,
    private readonly tenantId: TenantId,
  ) {
    this.policy = deps.policy ?? DEFAULT_EXECUTION_POLICY;
    this.dag = deps.dag ?? DEFAULT_DAG;
    this.workerId = createWorkerId(tenantId);
    this.worker = new DurableWorker(deps, tenantId);
  }

  private buildBudget(request: SubmitRequest): RunBudget {
    const policy = request.policyOverride
      ? applyPolicyOverride(
          this.policy,
          request.policyOverride as Parameters<typeof applyPolicyOverride>[1],
        )
      : this.policy;
    return {
      maxRuntimeMs: policy.maxRuntimeMs,
      maxModelCalls: policy.maxModelCalls,
      maxToolCalls: policy.maxToolCalls,
      maxInputTokens: policy.maxInputTokens,
      maxOutputTokens: policy.maxOutputTokens,
    };
  }

  /**
   * Submit a job for durable execution with real idempotency (F-2).
   *
   * The idempotency key is derived from (tenant, objective) when none is
   * supplied. The check is atomic against the shared `IdempotencyStore`: two
   * runtimes submitting the same operation concurrently will have exactly one
   * "recorded" and the rest "duplicate" — and the duplicate returns the prior
   * job/run without creating a second logical operation.
   */
  async submit(request: SubmitRequest): Promise<SubmitResult> {
    // Hard authorization gate (F-10).
    assertTenantKnown(this.deps.tenantIds, request.tenantId);
    assertAuthorized(request.tenantId, this.tenantId, "submit");

    const objectiveError = validateObjective(request.objective);
    if (objectiveError) {
      throw new Error(`invalid objective: ${objectiveError}`);
    }

    // Redact credential material BEFORE any durable record or deterministic id.
    const safeObjective = redactObjective(request.objective);

    const jobId = createDurableJobId(request.tenantId, safeObjective);
    // Tenant-salt ALWAYS: an explicit caller-supplied key must never collide
    // across tenants (Phase 4.7 finding — global keys were a cross-tenant
    // isolation defect).
    const idem = idemKey(
      request.tenantId,
      request.idempotencyKey ?? jobId,
      "submit",
    );

    // Atomic idempotency check (F-2).
    const recorded = await this.deps.idempotency.record(idem, "submit", {
      jobId,
    });
    const fresh = recorded === "recorded";

    if (!fresh) {
      // Another attempt claimed this key. If its submission fully
      // materialized AND its submission event is durably recorded, return it
      // (classic duplicate path).
      const existing = await this.deps.store.getJob(request.tenantId, jobId);
      if (
        existing?.currentRunId &&
        (await this.isRunMaterialized(existing.currentRunId)) &&
        (await this.hasSubmittedEvent(existing.currentRunId))
      ) {
        const run = await this.deps.store.getRun(existing.currentRunId);
        return {
          jobId,
          runId: existing.currentRunId,
          status: run ? run.status : existing.status,
          createdRun: false,
        };
      }
      // ORPHANED / INCOMPLETE SUBMISSION (Phase 4.8 crash-window findings D1,
      // D4): the prior attempt either died mid-materialization, or completed
      // every durable write but died before recording the `run.submitted`
      // event — a terminal-capable job with an empty audit trail.
      //
      // Correctness here does NOT depend on the grace window. Every write in
      // the materialization block below uses deterministic ids with CAS-guarded
      // saves, the event append is exactly-once at the backend level
      // (appendUnique), and the queue enqueue dedupes on its meta key — so a
      // concurrent recoverer can never double-apply. The wait below is a
      // CONTENTION DAMPENER that lets a slow-but-alive original finish without
      // extra write traffic; it is hard-bounded so no duplicate caller can ever
      // hang waiting on it.
      const graceMs = this.deps.submitOrphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
      const age = await this.reservationAgeMs(idem);
      if (age < graceMs) {
        const done = await this.awaitSubmissionCompletion(
          request.tenantId,
          jobId,
          Math.min(graceMs - age, COURTESY_WAIT_MS),
        );
        if (done?.currentRunId) {
          const run = await this.deps.store.getRun(done.currentRunId);
          return {
            jobId,
            runId: done.currentRunId,
            status: run ? run.status : done.status,
            createdRun: false,
          };
        }
      }
    }

    // ---- materialization (fresh submissions and orphan recovery alike) ----
    // Every write here is replay-safe: deterministic ids + CAS guards mean a
    // partially-completed earlier attempt is adopted or idempotently redone.
    const now = this.deps.clock.now();
    const budget = this.buildBudget(request);
    const dag = request.dag ?? this.dag;
    const dagErrors = validateDag(dag);
    if (dagErrors.length > 0) {
      throw new Error(`invalid DAG: ${dagErrors.join("; ")}`);
    }
    const deadlineAt = computeRunDeadline(budget, now);

    let job = await this.deps.store.getJob(request.tenantId, jobId);
    let runVersion: number;
    let resumeRunId: DurableRunId | undefined;
    if (!job) {
      runVersion = 1;
    } else {
      const candidate = job.currentRunId;
      const priorRun = candidate
        ? await this.deps.store.getRun(candidate)
        : undefined;
      if (candidate && (!priorRun || !isTerminal(priorRun.status))) {
        // Continue the interrupted/active run instead of minting a zombie:
        // its run number is exactly job.runCount.
        resumeRunId = candidate;
        runVersion = job.runCount ?? 1;
      } else {
        runVersion = (job.runCount ?? 0) + 1;
      }
    }
    const runId: DurableRunId =
      resumeRunId ?? createDurableRunId(jobId, runVersion);

    // Job row upsert. The CAS also elects a single writer when two runtimes
    // recover the same orphan simultaneously; losers adopt the winner's row.
    const desiredJob: Job = {
      ...(job ?? {
        id: jobId,
        tenantId: request.tenantId,
        objective: safeObjective,
        createdAt: now,
      }),
      id: jobId,
      tenantId: request.tenantId,
      objective: safeObjective,
      status: job && isTerminal(job.status) ? job.status : "running",
      runCount: Math.max(runVersion, job?.runCount ?? 0),
      currentRunId: runId,
      updatedAt: now,
      version: (job?.version ?? -1) + 1,
    };
    const jobSaved = await this.deps.store.saveJob(desiredJob, {
      idempotencyKey: idem,
    });
    if (!jobSaved) {
      job = await this.deps.store.getJob(request.tenantId, jobId);
      if (!job) {
        throw new Error(
          `failed to persist job ${jobId}: concurrent update conflict`,
        );
      }
    } else {
      job = desiredJob;
    }

    let run = resumeRunId
      ? await this.deps.store.getRun(resumeRunId)
      : undefined;
    if (!run) {
      const newRun: Run = {
        id: runId,
        jobId,
        tenantId: request.tenantId,
        version: 1,
        status: "queued",
        createdAt: now,
        taskIds: [],
        leasedStepIds: [],
        versionToken: 0,
        budget,
        deadlineAt,
        usage: {
          modelCalls: 0,
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          executionMs: 0,
        },
      };
      if (await this.deps.store.saveRun(newRun)) {
        run = newRun;
      } else {
        run = await this.deps.store.getRun(runId); // adopt concurrent winner
      }
    }
    if (!run) {
      throw new Error(
        `failed to persist run ${runId}: concurrent update conflict`,
      );
    }

    // Plan the DAG (F-7). Deterministic task/step ids make replay a no-op for
    // anything already persisted (CAS-guarded saves reject stale versions).
    const planned = await planDag(
      dag,
      jobId,
      runId,
      request.tenantId,
      now,
      (id, task) => this.deps.store.saveTask(id, task),
      (step, v) => this.deps.store.saveStep(step, v),
      deadlineAt,
    );
    const updatedRun: Run = {
      ...run,
      taskIds: [
        ...new Set([...(run.taskIds ?? []), ...planned.map((p) => p.task.id)]),
      ],
      status: isTerminal(run.status) ? run.status : "running",
      version: run.version + 1,
    };
    // Racer may have written the same merged update — either outcome is fine.
    await this.deps.store.saveRun(updatedRun);

    await this.deps.events.append({
      runId,
      type: "run.submitted",
      tenantId: request.tenantId,
      correlationId: runId,
      payload: { jobId, taskCount: planned.length, deadlineAt },
      idempotencyKey: `${idem}:submitted`,
    });

    // Real queue dispatch (F-9/F-11): persist then enqueue; do not execute here.
    await this.deps.queue.enqueue(
      { tenantId: request.tenantId, messageId: runId },
      {
        runId,
        jobId,
        tenantId: request.tenantId,
      },
      { idempotencyKey: idem },
    );

    return { jobId, runId, status: "running", createdRun: fresh };
  }

  /**
   * A run counts as materialized once every planned task and its current step
   * are durably present. Partial states (crash mid-submit) fail this check and
   * trigger orphan recovery instead of returning a dead pending result.
   */
  private async isRunMaterialized(runId: DurableRunId): Promise<boolean> {
    const run = await this.deps.store.getRun(runId);
    if (!run || run.taskIds.length === 0) return false;
    for (const taskId of run.taskIds) {
      const task = await this.deps.store.getTask(taskId);
      if (!task?.currentStepId) return false;
      const step = await this.deps.store.getStep(task.currentStepId);
      if (!step) return false;
    }
    return true;
  }

  /**
   * The submission counts as durably recorded only if a `run.submitted` event
   * exists in the run's stream (Phase 4.8 finding D4: task/step presence alone
   * let a crash-before-event submit be classified "materialized", producing
   * terminal jobs with zero audit trail). Stream membership — not the dedup
   * marker — is the authority, because a death between stream append and any
   * bookkeeping write must still count as recorded.
   */
  private async hasSubmittedEvent(runId: DurableRunId): Promise<boolean> {
    const events = await this.deps.events.replay(runId);
    return events.some((e) => e.type === "run.submitted");
  }

  /**
   * Poll for the original submission to become fully durable (job + DAG +
   * submitted event). Wall-clock bounded by maxWaitMs with a fixed cadence;
   * never throws, returns undefined if the window elapses first.
   */
  private async awaitSubmissionCompletion(
    tenantId: string,
    jobId: DurableJobId,
    maxWaitMs: number,
  ): Promise<Job | undefined> {
    const iterations = Math.max(2, Math.ceil(maxWaitMs / 25));
    for (let i = 0; i < iterations; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const job = await this.deps.store.getJob(tenantId, jobId);
      if (
        job?.currentRunId &&
        (await this.isRunMaterialized(job.currentRunId)) &&
        (await this.hasSubmittedEvent(job.currentRunId))
      ) {
        return job;
      }
    }
    return undefined;
  }

  private async reservationAgeMs(idemKeyStr: string): Promise<number> {
    const rec = await this.deps.idempotency.get(idemKeyStr);
    if (!rec) return Number.POSITIVE_INFINITY;
    return Date.now() - rec.recordedAt;
  }

  /**
   * Drive one worker cycle. Call in a loop (or via `runWorker`) to make
   * progress. Returns false when there was no work to do.
   */
  async processOne(): Promise<boolean> {
    const res = await this.worker.processOne(this.workerId);
    return res.executed || res.outcome !== "skipped";
  }

  /**
   * Run a worker until the queue is drained or `maxSteps` steps have been
   * processed. Used by tests and by a long-lived worker process.
   */
  async runWorker(
    opts: { maxSteps?: number; stopWhenIdle?: boolean } = {},
  ): Promise<number> {
    const max = opts.maxSteps ?? 10_000;
    let processed = 0;
    for (let i = 0; i < max; i++) {
      const did = await this.processOne();
      if (did) processed++;
      if (opts.stopWhenIdle && !did) break;
    }
    return processed;
  }

  /**
   * Reconciliation (F-9 / failure-model "lost acknowledgement"): re-enqueue a
   * work message for every active run so a worker can pick it up again.
   *
   * The queue is transport, not truth. A run can become stuck in a non-terminal
   * state if the producing worker died *after* acknowledging the prior message
   * but *before* re-enqueuing the next one, or if the queue lost a message. The
   * durable store is the source of truth: any run still in queued/running is not
   * done, so it must have a runnable path forward. This loop rediscovers those
   * runs and re-injects exactly one work command per active run.
   *
   * The enqueue is idempotent: the queue dedups on `(messageId)` where the
   * messageId is the runId, so a redundant reconcile does not flood the queue —
   * it is a no-op when an in-flight work command already exists.
   *
   * Returns the number of runs re-enqueued. Call periodically (e.g. a cron
   * Worker) and after suspected message loss.
   */
  async reconcile(): Promise<number> {
    let requeued = 0;
    // Phase 4.8 (D2): heal visibility orphans BEFORE re-enqueueing, since an
    // invisible-but-meta-committed message would otherwise be skipped forever
    // by enqueue's dup check.
    const q = this.deps.queue as Queue & {
      repair?: () => Promise<{ revisible: number; pruned: number }>;
    };
    if (typeof q.repair === "function") {
      await q.repair();
    }
    const activeRunIds = await this.deps.store.listActiveRunIds();
    for (const runId of activeRunIds) {
      const run = await this.deps.store.getRun(runId);
      if (!run) continue;
      if (isTerminal(run.status)) continue;
      // Don't fight cancellation: if a marker exists the next worker poll will
      // drain it to cancelled; re-enqueuing is harmless (idempotent) anyway.
      const ok = await this.deps.queue.enqueue(
        { tenantId: run.tenantId, messageId: runId },
        { runId: run.id, jobId: run.jobId, tenantId: run.tenantId },
        {
          idempotencyKey: idemKey(run.tenantId, run.id, "work"),
        },
      );
      if (ok) requeued++;
    }
    return requeued;
  }

  /**
   * Drive one reconciliation + worker drain cycle. Convenience for a
   * self-healing worker process: reconcile lost messages, then process until
   * idle. Returns total steps processed.
   */
  async reconcileAndDrive(opts: { maxSteps?: number } = {}): Promise<number> {
    await this.reconcile();
    return this.runWorker({ ...opts, stopWhenIdle: true });
  }

  /**
   * Durable cancellation (F-3). Writes a crash-surviving marker observed by
   * every worker, so cancellation on Runtime A stops work on Runtime B.
   */
  async cancel(request: CancelRequest): Promise<CancelResult> {
    const owner = await this.deps.store.resolveJobTenant(request.jobId);
    if (!owner) {
      return { jobId: request.jobId, cancelled: false, alreadyTerminal: false };
    }
    assertAuthorized(request.tenantId, owner, "cancel");
    const job = await this.deps.store.getJob(owner, request.jobId);
    if (!job) {
      return { jobId: request.jobId, cancelled: false, alreadyTerminal: false };
    }
    if (isTerminal(job.status)) {
      return { jobId: request.jobId, cancelled: false, alreadyTerminal: true };
    }
    const now = this.deps.clock.now();
    if (job.currentRunId) {
      await this.deps.store.setCancellationMarker(
        job.currentRunId,
        request.tenantId,
        "operator",
        request.reason,
        now,
      );
    }
    return { jobId: request.jobId, cancelled: true, alreadyTerminal: false };
  }

  async getJob(
    jobId: DurableJobId,
    tenantId: TenantId,
  ): Promise<JobState | undefined> {
    const owner = await this.deps.store.resolveJobTenant(jobId);
    if (!owner) return undefined;
    assertAuthorized(tenantId, owner, "getJob");
    const job = await this.deps.store.getJob(owner, jobId);
    if (!job) return undefined;
    const run = job.currentRunId
      ? await this.deps.store.getRun(job.currentRunId)
      : undefined;
    if (!run) return undefined;

    const tasks = [];
    for (const taskId of run.taskIds) {
      const t = await this.deps.store.getTask(taskId);
      if (t) tasks.push(t);
    }
    const steps = [];
    for (const t of tasks) {
      if (t.currentStepId) {
        const s = await this.deps.store.getStep(t.currentStepId);
        if (s) steps.push(s);
      }
    }
    const events = await this.deps.events.replay(run.id);
    return {
      job,
      run,
      tasks,
      steps,
      events: events.map(redactDurableEvent),
      cursor:
        events.length > 0
          ? encodeCursor(run.id, events[events.length - 1]!.sequence)
          : "",
    };
  }

  async streamEvents(
    jobId: DurableJobId,
    tenantId: TenantId,
    cursor?: string,
  ): Promise<AsyncIterable<DurableEvent>> {
    const owner = await this.deps.store.resolveJobTenant(jobId);
    if (!owner) return emptyAsyncIterable<DurableEvent>();
    assertAuthorized(tenantId, owner, "streamEvents");
    const job = await this.deps.store.getJob(owner, jobId);
    if (!job) return emptyAsyncIterable<DurableEvent>();
    const run = job.currentRunId
      ? await this.deps.store.getRun(job.currentRunId)
      : undefined;
    if (!run) return emptyAsyncIterable<DurableEvent>();
    const fromSeq = cursor ? (decodeSeq(cursor) ?? 0) : 0;
    const events = (await this.deps.events.replay(run.id, fromSeq)).map(
      redactDurableEvent,
    );
    return toAsyncIterable(events);
  }
}

function decodeSeq(token: string): number | undefined {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf(":");
    if (sep === -1) return undefined;
    const seq = Number.parseInt(decoded.slice(sep + 1), 10);
    return Number.isNaN(seq) ? undefined : seq;
  } catch {
    return undefined;
  }
}

async function* toAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return { next: async () => ({ done: true, value: undefined as T }) };
    },
  };
}

export { AuthorizationError };
