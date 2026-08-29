/* eslint-disable max-classes-per-file */
/**
 * Vaulltcore Durable Execution — durable worker.
 *
 * A worker is the disposable, stateless unit that turns queued work into
 * durable progress. The worker lifecycle is explicit and crash-recoverable:
 *
 *   IDLE → POLL → CLAIM → EXECUTE → HEARTBEAT → CHECKPOINT → COMMIT → RELEASE
 *
 * On failure:
 *   EXECUTE → WORKER DIES → LEASE EXPIRES → NEW WORKER CLAIMS →
 *   LOAD CHECKPOINT → RESUME
 *
 * Workers never own a job permanently and never require stickiness. Any worker
 * process (Runtime A or Runtime B) can pick up and finish any step because all
 * authoritative state lives in the shared stores, and all commits are fenced
 * by the lease `version` it holds.
 *
 * This worker operates against the provider-neutral contracts, so it runs
 * identically over `InMemory*` (single process) or `Distributed*` (shared
 * backend, multiple processes) stores.
 */

import type {
  DurableJobId,
  DurableRunId,
  DurableStepId,
  TenantId,
  WorkerId,
  IdempotencyKey,
} from "./identity";
import type {
  CheckpointStore,
  Clock,
  EventStore,
  Queue,
  StepExecutor,
  StepResult,
  TaskLeaseStore,
  WorkflowStore,
  IdempotencyStore,
} from "./contracts";
import type { Run, RunUsage, Step, Task } from "./model";
import { isTerminal } from "./status";
import { DurableScheduler } from "./scheduler";
import { DEFAULT_LEASE_CONFIG, computeLeaseTtl } from "./leases";
import { createCheckpoint, deriveResumePoint } from "./checkpoints";
import {
  checkBudget,
  initialBudget,
  computeRunDeadline,
  isDeadlineExceeded,
} from "./deadlines";
import type { BudgetState } from "./deadlines";
import { decideRetry, linearCongruentialRng, type RetryContext } from "./retry";
import { DEFAULT_EXECUTION_POLICY } from "@vaulltcore/intelligence";
import { idemKey } from "./identity";

export type WorkerPhase =
  | "idle"
  | "poll"
  | "claim"
  | "execute"
  | "heartbeat"
  | "checkpoint"
  | "commit"
  | "release"
  | "crashed";

export interface WorkerDeps {
  readonly store: WorkflowStore;
  readonly leases: TaskLeaseStore;
  readonly events: EventStore;
  readonly checkpoints: CheckpointStore;
  readonly queue: Queue;
  readonly clock: Clock;
  readonly executor: StepExecutor;
  readonly idempotency: IdempotencyStore;
  /** Heartbeat loop used during EXECUTE; defaults to no-op (unit tests). */
  readonly heartbeatMs?: number;
}

export interface WorkerStepResult {
  readonly executed: boolean;
  readonly stepId?: DurableStepId;
  readonly outcome:
    | "completed"
    | "failed"
    | "retryable"
    | "skipped"
    | "rejected";
  readonly phase: WorkerPhase;
}

/**
 * A durable worker. `processOne()` performs exactly one full lifecycle over a
 * single claimed step and returns. Callers (the runtime) loop over
 * `processOne()` until the queue is drained or a stop signal is given.
 *
 * If `crash` is set, the worker simulates a hard process death after EXECUTE
 * by throwing `CrashError` *without* releasing the lease — modelling a worker
 * that disappeared. Recovery is then performed by another worker instance.
 */
export class DurableWorker {
  public phase: WorkerPhase = "idle";
  private readonly scheduler: DurableScheduler;
  private readonly workerId: WorkerId;
  private readonly clock: Clock;
  private readonly heartbeatMs: number;

  constructor(
    private readonly deps: WorkerDeps,
    tenantId: TenantId,
    private readonly options: {
      crashAfterExecute?: boolean;
      chaos?: never;
    } = {},
  ) {
    this.scheduler = new DurableScheduler(
      deps.store,
      deps.leases,
      deps.clock,
      DEFAULT_LEASE_CONFIG,
    );
    this.clock = deps.clock;
    this.heartbeatMs = deps.heartbeatMs ?? 0;
    this.workerId =
      (deps.executor as unknown as { workerId?: WorkerId })?.workerId ??
      `${tenantId}:worker:${Math.random().toString(36).slice(2, 12)}`;
  }

  get id(): WorkerId {
    return this.workerId;
  }

  /**
   * Claim and execute a single step. Returns what happened. On a simulated
   * crash the worker throws and leaves the lease intact.
   */
  async processOne(workerIdOverride?: WorkerId): Promise<WorkerStepResult> {
    const workerId = workerIdOverride ?? this.workerId;
    this.phase = "poll";
    const claimed = await this.deps.queue.claim(workerId, 1, 30_000);
    if (claimed.length === 0) {
      this.phase = "idle";
      return { executed: false, outcome: "skipped", phase: "idle" };
    }
    const message = claimed[0]!;
    const payload = message.payload as {
      runId: DurableRunId;
      jobId: DurableJobId;
      tenantId: TenantId;
    };
    const run = await this.deps.store.getRun(payload.runId);
    if (!run || isTerminal(run.status)) {
      await this.deps.queue.ack(message, workerId);
      this.phase = "idle";
      return { executed: false, outcome: "skipped", phase: "idle" };
    }

    // Observe durable cancellation marker (cross-process).
    const marker = await this.deps.store.getCancellationMarker(run.id);
    if (marker) {
      await this.cancelRun(run, marker.reason, marker.requestedBy);
      await this.deps.queue.ack(message, workerId);
      this.phase = "release";
      return { executed: false, outcome: "skipped", phase: "release" };
    }

    // Release the next runnable step for this run via the scheduler.
    this.phase = "claim";
    const releaseResult = await this.scheduler.releaseSteps(run.id, workerId);
    if (releaseResult.length === 0) {
      // Nothing runnable right now (blocked deps, or already claimed).
      await this.deps.queue.retry(message, 50);
      this.phase = "idle";
      return { executed: false, outcome: "skipped", phase: "idle" };
    }
    const candidate = releaseResult[0]!;
    const step = await this.deps.store.getStep(candidate.step.id);
    const task = await this.deps.store.getTask(candidate.task.id);
    if (!step || !task) {
      await this.deps.queue.retry(message, 50);
      this.phase = "idle";
      return { executed: false, outcome: "skipped", phase: "idle" };
    }

    // Budget guard before execution (F-5).
    const budgetCheck = await this.guardBudget(run);
    if (budgetCheck !== null) {
      await this.failRunBudget(run, budgetCheck);
      await this.deps.queue.ack(message, workerId);
      this.phase = "commit";
      return {
        executed: false,
        stepId: step.id,
        outcome: "rejected",
        phase: "commit",
      };
    }

    const lease = await this.deps.leases.getLease(step.id);
    if (!lease || lease.owner !== workerId) {
      await this.deps.queue.retry(message, 50);
      this.phase = "idle";
      return { executed: false, outcome: "skipped", phase: "idle" };
    }

    this.phase = "execute";
    const stepIdem: IdempotencyKey = idemKey(
      run.tenantId,
      `${run.id}:${step.id}:${step.attempt}`,
      "step",
    );
    const execution = {
      step,
      task,
      job: (await this.deps.store.getJob(run.tenantId, run.jobId))!,
      lease,
      correlationId: run.id,
      deadlineMs:
        (step.deadlineAt ?? run.deadlineAt ?? this.clock.now()) -
        this.clock.now(),
      idempotencyKey: stepIdem,
    };

    let result: StepResult;
    try {
      result = await this.deps.executor.execute(execution, neverAbort());
    } catch (err) {
      // Worker "died" mid-execute. If simulated crash, leave lease intact.
      if (this.options.crashAfterExecute) {
        this.phase = "crashed";
        throw new WorkerCrashError(String((err as Error)?.message ?? err));
      }
      await this.deps.leases.revoke(lease.id, workerId);
      await this.deps.queue.retry(message, 100);
      this.phase = "release";
      return {
        executed: false,
        outcome: "failed",
        phase: "release",
        stepId: step.id,
      };
    }

    // Heartbeat (no-op in tests; real workers renew the lease here).
    if (this.heartbeatMs > 0) {
      this.phase = "heartbeat";
      await this.deps.leases.renew(
        lease.id,
        workerId,
        computeLeaseTtl(
          step.deadlineAt,
          this.clock.now(),
          DEFAULT_LEASE_CONFIG,
        ),
      );
    }

    // Persist a durable checkpoint of the step outcome (F-4).
    this.phase = "checkpoint";
    await this.persistCheckpoint(step, task, run, result);

    // Commit, fenced by lease version (F-1).
    this.phase = "commit";
    if (result.error) {
      const fail = await this.scheduler.failStep(
        { ...step, status: "running" },
        { ...result.error, createdAt: this.clock.now() },
      );
      await this.deps.leases.revoke(lease.id, workerId);
      await this.accumulateUsage(run, result);
      // Decide retry.
      const retry = this.decideStepRetry(run, step, result);
      if (retry && fail.retryable) {
        await this.spawnRetry(run, task, step, result);
        await this.deps.queue.retry(message, 50);
        return {
          executed: true,
          stepId: step.id,
          outcome: "retryable",
          phase: "release",
        };
      }
      await this.maybeFinalize(run, false);
      await this.deps.queue.ack(message, workerId);
      return {
        executed: true,
        stepId: step.id,
        outcome: "failed",
        phase: "release",
      };
    }

    const commit = await this.scheduler.completeStep(
      step.id,
      result.output,
      result.usage ?? {},
      workerId,
      lease.id,
      lease.version,
    );
    if (!commit.success) {
      // Fencing rejected our commit (we lost the lease). Requeue.
      await this.deps.queue.retry(message, 50);
      this.phase = "release";
      return {
        executed: true,
        stepId: step.id,
        outcome: "rejected",
        phase: "release",
      };
    }
    await this.accumulateUsage(run, result);

    // Re-check budget after this step's usage is accumulated: a single step may
    // itself push the run over its limit. Breach => deterministic fail.
    const postBreach = await this.guardBudget(run);
    if (postBreach !== null) {
      await this.failRunBudget(run, postBreach);
      this.phase = "release";
      await this.deps.queue.ack(message, workerId);
      return {
        executed: true,
        stepId: step.id,
        outcome: "rejected",
        phase: "release",
      };
    }

    // Check if the whole run is now complete.
    await this.maybeFinalizeRefreshed(run);

    // Acknowledge first so the message meta is cleared; then re-enqueue work
    // (if the run is still active) so a now-unblocked dependent task is picked
    // up by any worker. Re-enqueuing after ack avoids the queue's per-message
    // dedup rejecting the duplicate id while the prior meta is still in-flight.
    this.phase = "release";
    await this.deps.queue.ack(message, workerId);

    const refreshed = (await this.deps.store.getRun(run.id))!;
    if (!isTerminal(refreshed.status)) {
      await this.deps.queue.enqueue(
        { tenantId: run.tenantId, messageId: run.id },
        { runId: run.id, jobId: run.jobId, tenantId: run.tenantId },
        {
          idempotencyKey: idemKey(run.tenantId, run.id, "work"),
        },
      );
    }
    return {
      executed: true,
      stepId: step.id,
      outcome: "completed",
      phase: "release",
    };
  }

  private async maybeFinalizeRefreshed(run: Run): Promise<void> {
    await this.maybeFinalize(run, true);
  }

  private async guardBudget(run: Run): Promise<string | null> {
    const usage = await this.readUsage(run);
    const breach = checkBudget(usage, run.budget, this.clock.now());
    if (breach) return breach.kind;
    if (isDeadlineExceeded(run.deadlineAt, this.clock.now())) return "runtime";
    return null;
  }

  private async readUsage(run: Run): Promise<BudgetState> {
    const wstore = this.deps.store as unknown as {
      getRunUsage?: (runId: string) => Promise<RunUsage | undefined>;
    };
    if (typeof wstore.getRunUsage === "function") {
      const u = await wstore.getRunUsage(run.id);
      if (u) {
        return {
          startedAt: run.createdAt,
          modelCalls: u.modelCalls,
          toolCalls: u.toolCalls,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
        };
      }
    }
    return initialBudget(run.createdAt);
  }

  private async accumulateUsage(run: Run, result: StepResult): Promise<void> {
    const wstore = this.deps.store as unknown as {
      addRunUsage?: (
        runId: string,
        delta: Partial<RunUsage>,
        startedAt: number,
      ) => Promise<boolean>;
    };
    if (typeof wstore.addRunUsage === "function") {
      const usage = result.usage ?? {};
      await wstore.addRunUsage(
        run.id,
        {
          modelCalls: Number(usage.modelCalls ?? 0),
          toolCalls: Number(usage.toolCalls ?? 0),
          inputTokens: Number(usage.inputTokens ?? 0),
          outputTokens: Number(usage.outputTokens ?? 0),
          executionMs: 0,
        },
        run.createdAt,
      );
    }
  }

  private decideStepRetry(run: Run, step: Step, result: StepResult): boolean {
    const policy = DEFAULT_EXECUTION_POLICY.retry;
    const ctx: RetryContext = {
      attempt: step.attempt - 1,
      startedAt: step.createdAt,
      deadlineAt: run.deadlineAt,
      elapsedRetryMs: 0,
      failure: result.error!,
    };
    const decision = decideRetry(
      policy,
      ctx,
      linearCongruentialRng(42),
      this.clock.now(),
    );
    return decision.retry;
  }

  private async spawnRetry(
    run: Run,
    task: Task,
    failedStep: Step,
    result: StepResult,
  ): Promise<void> {
    const nextAttempt = failedStep.attempt + 1;
    const stepId = `${failedStep.taskId}:step:${nextAttempt}`;
    const newStep: Step = {
      id: stepId,
      runId: run.id,
      taskId: task.id,
      tenantId: run.tenantId,
      attempt: nextAttempt,
      taskIdRef: task.spec.id,
      status: "queued",
      createdAt: this.clock.now(),
      version: 0,
      deadlineAt: failedStep.deadlineAt,
    };
    await this.deps.store.saveStep(newStep, 0);
    const updatedTask: Task = {
      ...task,
      attempt: nextAttempt,
      currentStepId: stepId,
      status: "queued",
      version: task.version + 1,
      lastError: result.error,
    };
    await this.deps.store.saveTask(task.id, updatedTask);
  }

  private async persistCheckpoint(
    step: Step,
    task: Task,
    run: Run,
    result: StepResult,
  ): Promise<void> {
    const prior = await this.deps.checkpoints.listForStep(step.id);
    const sequence = prior.length;
    const checkpoint = createCheckpoint(
      step.id,
      sequence,
      {
        status: result.error ? "failed" : "completed",
        runId: run.id,
        taskId: task.id,
        jobId: run.jobId,
        stepStatus: step.status,
        attempt: step.attempt,
        completed: !result.error,
      },
      [],
      step.attempt,
      this.clock.now(),
      run.id,
      task.id,
    );
    await this.deps.checkpoints.save(checkpoint);
    void deriveResumePoint;
  }

  private async maybeFinalize(run: Run, success: boolean): Promise<void> {
    const latest = (await this.deps.store.getRun(run.id))!;
    const allTasks = await this.allRunTasks(latest);
    const allTerminal = allTasks.every(
      (t) =>
        isTerminal(t.status) ||
        t.status === "completed" ||
        t.status === "failed" ||
        t.status === "cancelled",
    );
    const anyFailed = allTasks.some(
      (t) => t.status === "failed" || t.status === "cancelled",
    );
    if (!allTerminal) return;
    const finalStatus =
      anyFailed && !success
        ? "failed"
        : success && !anyFailed
          ? "completed"
          : anyFailed
            ? "failed"
            : "completed";
    // The run state machine requires running -> verifying -> completed (or
    // running -> failed). Transition through the intermediate state.
    const intermediate =
      finalStatus === "completed" ? "verifying" : finalStatus;
    const v1 = (await this.deps.store.getRun(run.id))!;
    await this.deps.store
      .transitionRun(v1.id, v1.status, intermediate, {
        expectedVersion: v1.version,
        actor: this.workerId,
        source: "DurableWorker.maybeFinalize",
        correlationId: run.id,
      })
      .catch(() => undefined);
    const v2 = (await this.deps.store.getRun(run.id))!;
    if (v2.status !== finalStatus) {
      await this.deps.store
        .transitionRun(v2.id, v2.status, finalStatus, {
          expectedVersion: v2.version,
          actor: this.workerId,
          source: "DurableWorker.maybeFinalize",
          correlationId: run.id,
        })
        .catch(() => undefined);
    }
    const job = await this.deps.store.getJob(run.tenantId, run.jobId);
    if (job) {
      await this.deps.store.saveJob({
        ...job,
        status: finalStatus,
        updatedAt: this.clock.now(),
        version: job.version + 1,
      });
    }
  }

  private async allRunTasks(run: Run): Promise<Task[]> {
    const tasks: Task[] = [];
    for (const taskId of run.taskIds) {
      const t = await this.deps.store.getTask(taskId);
      if (t) tasks.push(t);
    }
    return tasks;
  }

  private async cancelRun(
    run: Run,
    reason: string,
    requestedBy: string,
  ): Promise<void> {
    const latest = (await this.deps.store.getRun(run.id))!;
    await this.deps.store
      .transitionRun(latest.id, latest.status, "cancel_requested", {
        expectedVersion: latest.version,
        actor: requestedBy,
        source: "DurableWorker.cancelRun",
        correlationId: run.id,
        reason,
      })
      .catch(() => undefined);
    const v2 = (await this.deps.store.getRun(run.id))!;
    await this.deps.store
      .transitionRun(v2.id, v2.status, "cancelled", {
        expectedVersion: v2.version,
        actor: requestedBy,
        source: "DurableWorker.cancelRun",
        correlationId: run.id,
        reason,
      })
      .catch(() => undefined);
    const job = await this.deps.store.getJob(run.tenantId, run.jobId);
    if (job) {
      await this.deps.store.saveJob({
        ...job,
        status: "cancelled",
        updatedAt: this.clock.now(),
        version: job.version + 1,
      });
    }
  }

  private async failRunBudget(run: Run, kind: string): Promise<void> {
    const latest = (await this.deps.store.getRun(run.id))!;
    await this.deps.store
      .transitionRun(latest.id, latest.status, "failed", {
        expectedVersion: latest.version,
        actor: this.workerId,
        source: "DurableWorker.failRunBudget",
        correlationId: run.id,
        reason: `budget_exhausted:${kind}`,
      })
      .catch(() => undefined);
    const job = await this.deps.store.getJob(run.tenantId, run.jobId);
    if (job) {
      await this.deps.store.saveJob({
        ...job,
        status: "failed",
        updatedAt: this.clock.now(),
        version: job.version + 1,
        reason: `budget_exhausted:${kind}`,
      });
    }
  }
}

/** AbortSignal that never fires — used because cancellation is durable/marker-driven. */
function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

/** Thrown by a worker that simulates a hard crash (process death). */
export class WorkerCrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerCrashError";
  }
}

void computeRunDeadline;
