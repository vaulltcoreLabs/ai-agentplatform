/**
 * Vaulltcore Durable Execution — runtime.
 *
 * The `DurableWorkflowRuntime` implements the `WorkflowRuntime` contract using
 * the provider-neutral stores and the `DurableScheduler`. It owns the full
 * lifecycle:
 *
 *   submit → createJob → createRun → plan → createSteps → executeLoop → verify → terminal
 *
 * The execution loop: releases steps (lease + dispatch to the injected
 * `StepExecutor`), collects results, advances task/run state, and handles
 * retries via the retry engine. When all steps are terminal, it transitions
 * the run through verification to completion.
 *
 * A no-op `StepExecutor` (`NoopStepExecutor`) is provided for tests and as a
 * reference implementation of the adapter boundary.
 */

/* eslint-disable max-classes-per-file */

import type { DurableJobId, TenantId, WorkerId } from "./identity";
import type {
  DurableEvent,
  Job,
  Run,
  Step,
  StepExecution,
  Task,
  DurableTaskSpec,
  RunBudget,
} from "./model";
import type {
  CheckpointStore,
  Clock,
  EventStore,
  IdempotencyStore,
  Queue,
  StepExecutor,
  StepResult,
  SubmitRequest,
  SubmitResult,
  CancelRequest,
  CancelResult,
  JobState,
  WorkflowRuntime,
  WorkflowStore,
  TaskLeaseStore,
} from "./contracts";
import {
  createDurableJobId,
  createDurableRunId,
  createDurableTaskId,
  createDurableStepId,
  createWorkerId,
  idemKey,
} from "./identity";
import { isTerminal, runCanTransition } from "./status";
import type { RunStatus } from "./status";
import { DurableScheduler } from "./scheduler";
import {
  DEFAULT_EXECUTION_POLICY,
  applyPolicyOverride,
  type ExecutionPolicy,
  type TaskStatus,
  type VerificationBackend,
  type VerificationResult,
} from "@vaulltcore/intelligence";
import { DEFAULT_LEASE_CONFIG } from "./leases";
import { CancellationHub } from "./cancellation";
import { TenantScope, type TenantConfig } from "./tenant";
import {
  ChaosInjector,
  type FaultPlan,
  NoopChaosInjector,
  CrashError,
} from "./chaos";
import { linearCongruentialRng } from "./retry";
import { computeRunDeadline, checkBudget, initialBudget } from "./deadlines";
import type { BudgetState } from "./deadlines";
import { redactDurableEvent, validateObjective } from "./security";
import { assertAuthorized, assertTenantKnown } from "./authorization";
import type { Sandbox } from "@vaulltcore/sandbox";

export { CancellationHub, TenantScope, NoopChaosInjector };
export { assertAuthorized, assertTenantKnown } from "./authorization";
export type { FaultPlan };

/**
 * Default budget derived from Phase 3's `DEFAULT_EXECUTION_POLICY`.
 */
export function defaultBudget(): RunBudget {
  return {
    maxRuntimeMs: DEFAULT_EXECUTION_POLICY.maxRuntimeMs,
    maxModelCalls: DEFAULT_EXECUTION_POLICY.maxModelCalls,
    maxToolCalls: DEFAULT_EXECUTION_POLICY.maxToolCalls,
    maxInputTokens: DEFAULT_EXECUTION_POLICY.maxInputTokens,
    maxOutputTokens: DEFAULT_EXECUTION_POLICY.maxOutputTokens,
  };
}

/**
 * A no-op executor that produces deterministic canned results. Useful for
 * tests and as a reference for real `StepExecutor` adapters.
 */
export class NoopStepExecutor implements StepExecutor {
  async execute(
    _execution: StepExecution,
    _signal: AbortSignal,
  ): Promise<StepResult> {
    return {
      output: { status: "ok", note: "noop executor" },
      usage: { modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5 },
      artifacts: [],
    };
  }
}

export interface DurableRuntimeDeps {
  readonly store: WorkflowStore;
  readonly leases: TaskLeaseStore;
  readonly events: EventStore;
  readonly checkpoints: CheckpointStore;
  readonly queue: Queue;
  readonly clock: Clock;
  readonly executor: StepExecutor;
  readonly idempotency: IdempotencyStore;
  readonly policy?: ExecutionPolicy;
  readonly tenants?: TenantConfig[];
  readonly faultPlan?: FaultPlan;
  /**
   * Optional sandbox supplier. When provided alongside a `VerificationBackend`,
   * the runtime can provision a sandbox for verification checks (typecheck,
   * tests, lint) on completed tasks. Phase 4.3.
   */
  readonly sandboxSupplier?: (
    runId: string,
    tenantId: string,
  ) => Promise<Sandbox | undefined>;
  /**
   * Optional verification backend. When provided, the runtime calls
   * `verify` on completed runs to gather evidence before transitioning
   * to terminal state. Phase 4.3.
   */
  readonly verifier?: VerificationBackend;
}

/** Re-exported from tenant to avoid an extra import path. */
export type { TenantConfig } from "./tenant";

export class DurableWorkflowRuntime implements WorkflowRuntime {
  private readonly deps: DurableRuntimeDeps;
  private readonly scheduler: DurableScheduler;
  private readonly cancellation: CancellationHub;
  private readonly tenants: TenantScope;
  private readonly chaos: ChaosInjector | NoopChaosInjector;
  private readonly policy: ExecutionPolicy;
  private readonly workerId: WorkerId;
  private readonly verifier?: VerificationBackend;
  private readonly sandboxSupplier?: DurableRuntimeDeps["sandboxSupplier"];
  private readonly knownTenantIds: Set<string>;
  private readonly budgetStates = new Map<string, BudgetState>();

  constructor(deps: DurableRuntimeDeps, tenantId: TenantId) {
    this.deps = deps;
    this.scheduler = new DurableScheduler(
      deps.store,
      deps.leases,
      deps.clock,
      DEFAULT_LEASE_CONFIG,
    );
    this.cancellation = new CancellationHub();
    this.tenants = new TenantScope();
    this.chaos = deps.faultPlan
      ? new ChaosInjector(linearCongruentialRng(42))
      : new NoopChaosInjector();
    this.policy = deps.policy ?? DEFAULT_EXECUTION_POLICY;
    this.workerId = createWorkerId(tenantId);
    this.verifier = deps.verifier;
    this.sandboxSupplier = deps.sandboxSupplier;
    this.knownTenantIds = new Set(deps.tenants?.map((t) => t.tenantId));
    for (const tenant of deps.tenants ?? []) {
      this.tenants.register(tenant);
    }
    if (deps.faultPlan && this.chaos instanceof ChaosInjector) {
      this.chaos.install(deps.faultPlan);
    }
  }

  /**
   * Submit a job for durable execution.
   *
   * Idempotency: the same (tenantId, objective) produces the same job id.
   * If a job already exists for that key and is NOT terminal, it is resumed.
   * A terminal job gets a fresh run (version + 1).
   */
  async submit(request: SubmitRequest): Promise<SubmitResult> {
    const tenantId = request.tenantId;

    if (this.knownTenantIds.size > 0) {
      assertTenantKnown(this.knownTenantIds, tenantId);

      const quotaCheck = this.tenants.canStartRun(tenantId);
      if (!quotaCheck.allowed) {
        throw new SubmissionValidationError(
          `quota exceeded for tenant ${tenantId}: ${quotaCheck.reason}`,
        );
      }
    }

    const validationError = validateObjective(request.objective);
    if (validationError !== undefined) {
      throw new SubmissionValidationError(validationError);
    }

    const jobId = createDurableJobId(tenantId, request.objective);
    const now = this.deps.clock.now();

    // Phase 4.3: atomic idempotency check BEFORE creating any durable state.
    // Recording before execution makes the idempotency claim crash-safe: if the
    // process dies during executeRun, the key is already claimed and a restart
    // will correctly treat this as a duplicate (resume from durable state).
    if (request.idempotencyKey) {
      const recorded = await this.deps.idempotency.record(
        request.idempotencyKey,
        "submit",
        { jobId },
      );
      if (recorded === "duplicate" || recorded === "conflict") {
        // Another submission already claimed this key. Re-read the current
        // durable state from the store (the store is source of truth for the
        // latest status; the idempotency record is just a claim).
        const priorJob = await this.deps.store.getJob(tenantId, jobId);
        if (priorJob && priorJob.currentRunId) {
          return {
            jobId,
            runId: priorJob.currentRunId,
            status: priorJob.status,
            createdRun: false,
          };
        }
        return { jobId, runId: "", status: "created", createdRun: false };
      }
    }

    const existing = await this.deps.store.getJob(tenantId, jobId);

    if (existing && !isTerminal(existing.status)) {
      // Resume in-progress run
      if (existing.currentRunId) {
        const run = await this.deps.store.getRun(existing.currentRunId);
        if (run) {
          await this.executeRun(run);
        }
      }
      const final = await this.deps.store.getJob(tenantId, jobId);
      return {
        jobId,
        runId: final?.currentRunId ?? existing.currentRunId ?? "",
        status: final?.status ?? existing.status,
        createdRun: false,
      };
    }

    // Create new job + run
    const runVersion = existing ? (existing.runCount ?? 0) + 1 : 1;
    const runId = createDurableRunId(jobId, runVersion);
    const budget = this.buildBudget(request);

    const job: Job = {
      id: jobId,
      tenantId,
      objective: request.objective,
      status: "running",
      runCount: runVersion,
      currentRunId: runId,
      createdAt: now,
      updatedAt: now,
      version: existing ? existing.version + 1 : 0,
    };
    const jobSaved = await this.deps.store.saveJob(job, {
      idempotencyKey: request.idempotencyKey,
    });
    if (!jobSaved) {
      throw new SubmissionValidationError(
        `failed to persist job ${jobId}: concurrent update conflict`,
      );
    }

    const run: Run = {
      id: runId,
      jobId,
      tenantId,
      version: 1,
      status: "created",
      createdAt: now,
      taskIds: [],
      leasedStepIds: [],
      versionToken: 0,
      budget,
      deadlineAt: computeRunDeadline(budget, now),
    };
    const runSaved = await this.deps.store.saveRun(run);
    if (!runSaved) {
      throw new SubmissionValidationError(
        `failed to persist run ${runId}: concurrent update conflict`,
      );
    }

    this.tenants.incrementRuns(tenantId);
    this.budgetStates.set(runId, initialBudget(now));

    try {
      await this.executeRun(run);
    } finally {
      this.tenants.decrementRuns(tenantId);
      this.budgetStates.delete(runId);
    }

    const final = await this.deps.store.getJob(tenantId, jobId);
    const result: SubmitResult = {
      jobId,
      runId,
      status: final?.status ?? "created",
      createdRun: true,
    };

    return result;
  }

  /**
   * The core execution loop: plan → execute → verify → terminal.
   * Re-fetches the run after each state change to get fresh versions.
   */
  private async executeRun(run: Run): Promise<void> {
    const now = this.deps.clock.now();
    const deadlineAt = run.deadlineAt ?? computeRunDeadline(run.budget, now);

    let budget = this.budgetStates.get(run.id) ?? initialBudget(now);

    await this.deps.events.append({
      runId: run.id,
      type: "run.started",
      tenantId: run.tenantId,
      correlationId: run.id,
      payload: { deadlineAt },
    });

    const executionQueue: Task[] = [await this.planRun(run, deadlineAt)];

    while (executionQueue.length > 0) {
      const breach = checkBudget(budget, run.budget, this.deps.clock.now());
      if (breach) {
        await this.failRun(run, "failed");
        await this.finalizeJob(run, "failed");
        await this.deps.events.append({
          runId: run.id,
          type: "budget_exhausted",
          tenantId: run.tenantId,
          correlationId: run.id,
          payload: {
            kind: breach.kind,
            limit: breach.limit,
            observed: breach.observed,
          },
        });
        return;
      }

      const task = executionQueue.shift()!;
      const outcome = await this.executeTask(task, run, deadlineAt);

      const updatedStep = await this.deps.store.getStep(task.currentStepId!);
      if (updatedStep?.usage) {
        budget.modelCalls += Number(updatedStep.usage.modelCalls ?? 0);
        budget.toolCalls += Number(updatedStep.usage.toolCalls ?? 0);
        budget.inputTokens += Number(updatedStep.usage.inputTokens ?? 0);
        budget.outputTokens += Number(updatedStep.usage.outputTokens ?? 0);
      }
      this.budgetStates.set(run.id, budget);

      if (outcome === "retryable") {
        const retried = await this.retryTask(task, run, deadlineAt);
        if (retried && retried.attempt <= 5) {
          executionQueue.push(retried);
        } else {
          await this.failRun(run, "failed");
          await this.finalizeJob(run, "failed");
          return;
        }
      } else if (outcome === "failed") {
        await this.failRun(run, "failed");
        await this.finalizeJob(run, "failed");
        return;
      }
    }

    const finalBreach = checkBudget(budget, run.budget, this.deps.clock.now());
    if (finalBreach) {
      await this.failRun(run, "failed");
      await this.finalizeJob(run, "failed");
      await this.deps.events.append({
        runId: run.id,
        type: "budget_exhausted",
        tenantId: run.tenantId,
        correlationId: run.id,
        payload: {
          kind: finalBreach.kind,
          limit: finalBreach.limit,
          observed: finalBreach.observed,
        },
      });
      return;
    }

    // All tasks complete — verify & transition to completed
    const latestRun = (await this.deps.store.getRun(run.id))!;
    await this.deps.store.transitionRun(
      latestRun.id,
      latestRun.status,
      "verifying",
      {
        expectedVersion: latestRun.version,
        actor: this.workerId,
        source: "DurableWorkflowRuntime",
        correlationId: run.id,
        idempotencyKey: idemKey(run.tenantId, run.id, "transition:verifying"),
      },
    );

    const verifiedRun = (await this.deps.store.getRun(run.id))!;
    const verificationResult = await this.runVerification(verifiedRun);

    if (verificationResult && !verificationResult.passed) {
      await this.deps.store.transitionRun(
        verifiedRun.id,
        verifiedRun.status,
        "failed",
        {
          expectedVersion: verifiedRun.version,
          actor: this.workerId,
          source: "DurableWorkflowRuntime.verify",
          correlationId: run.id,
          reason: "verification_failed",
          idempotencyKey: idemKey(run.tenantId, run.id, "transition:failed"),
        },
      );
      await this.finalizeJob(run, "failed");
      await this.deps.events.append({
        runId: run.id,
        type: "run.failed",
        tenantId: run.tenantId,
        correlationId: run.id,
        payload: {
          reason: "verification_failed",
          failedChecks: [...(verificationResult.failedChecks ?? [])],
        },
      });
      return;
    }

    // Verification passed (or not configured) — transition to completed.
    const completedRun = (await this.deps.store.getRun(run.id))!;
    await this.deps.store.transitionRun(
      completedRun.id,
      completedRun.status,
      "completed",
      {
        expectedVersion: completedRun.version,
        actor: this.workerId,
        source: "DurableWorkflowRuntime",
        correlationId: run.id,
        idempotencyKey: idemKey(run.tenantId, run.id, "transition:completed"),
      },
    );

    await this.deps.events.append({
      runId: run.id,
      type: "run.completed",
      tenantId: run.tenantId,
      correlationId: run.id,
      payload: {},
    });

    await this.finalizeJob(run, "completed");
  }

  private async finalizeJob(run: Run, status: RunStatus): Promise<void> {
    const job = (await this.deps.store.getJob(run.tenantId, run.jobId))!;
    await this.deps.store.saveJob({
      ...job,
      status,
      updatedAt: this.deps.clock.now(),
      version: job.version + 1,
    });
  }

  private async failRun(run: Run, to: RunStatus): Promise<void> {
    const latestRun = (await this.deps.store.getRun(run.id))!;
    await this.deps.store.transitionRun(latestRun.id, latestRun.status, to, {
      expectedVersion: latestRun.version,
      actor: this.workerId,
      source: "DurableWorkflowRuntime",
      correlationId: run.id,
      idempotencyKey: idemKey(run.tenantId, run.id, `transition:${to}`),
    });
  }

  /**
   * Plan: create a task and its initial step. In production this delegates to
   * Phase 3's Planner + buildTaskGraph; the default runtime creates a single
   * "main" task.
   */
  private async planRun(run: Run, deadlineAt: number): Promise<Task> {
    const now = this.deps.clock.now();
    const taskId = createDurableTaskId(run.jobId, `${run.version}:${1}`);
    const taskSpec: DurableTaskSpec = {
      id: taskId,
      name: "main",
      specialist: "default",
      dependsOn: [],
      input: { jobId: run.jobId },
    };
    const task: Task = {
      id: taskId,
      runId: run.id,
      jobId: run.jobId,
      spec: taskSpec,
      status: "queued",
      attempt: 1,
      completedSteps: [],
      version: 0,
      startedAt: now,
      deadlineAt,
    };
    await this.deps.store.saveTask(taskId, task);

    // Create the initial step
    const stepId = createDurableStepId(taskId, 1);
    const step: Step = {
      id: stepId,
      runId: run.id,
      taskId,
      tenantId: run.tenantId,
      attempt: 1,
      taskIdRef: taskSpec.id,
      status: "created",
      createdAt: now,
      version: 0,
      deadlineAt,
    };
    await this.deps.store.saveStep(step, 0);

    const updatedTask: Task = {
      ...task,
      currentStepId: step.id,
      status: "queued",
      version: 1,
    };
    await this.deps.store.saveTask(taskId, updatedTask);

    // Mark run as running
    const updatedRun: Run = {
      ...run,
      taskIds: [taskId],
      status: "running",
      startedAt: now,
      version: run.version + 1,
    };
    await this.deps.store.saveRun(updatedRun);

    // Register for cancellation
    this.cancellation.register(run.id, run.tenantId);

    return updatedTask;
  }

  /**
   * Execute a single task's step: lease it, dispatch to executor, handle
   * success/failure. Returns "completed", "retryable", or "failed".
   */
  private async executeTask(
    task: Task,
    run: Run,
    deadlineAt: number,
  ): Promise<"completed" | "retryable" | "failed"> {
    const now = this.deps.clock.now();

    if (this.cancellation.isCancelled(run.id, run.tenantId)) {
      await this.scheduler.cancelStep(task.currentStepId!);
      return "failed";
    }

    const durableMarker = await this.deps.store.getCancellationMarker(run.id);
    if (durableMarker) {
      this.cancellation.cancel(
        run.id,
        run.tenantId,
        durableMarker.requestedBy,
        durableMarker.reason,
        durableMarker.requestedAt,
      );
      await this.scheduler.cancelStep(task.currentStepId!);
      return "failed";
    }

    const stepId = task.currentStepId!;
    const step = await this.deps.store.getStep(stepId);
    if (!step) return "failed";

    if (this.chaos instanceof ChaosInjector) {
      try {
        await this.chaos.inspect(step);
      } catch (err) {
        if (err instanceof CrashError) {
          throw err;
        }
        return "failed";
      }
    }

    const lease = await this.deps.leases.claim(
      stepId,
      this.workerId,
      DEFAULT_LEASE_CONFIG.ttlMs,
    );
    if (!lease) return "failed";

    const runningStep: Step = {
      ...step,
      status: "running",
      startedAt: this.deps.clock.now(),
      version: step.version + 1,
    };
    const stepSaved = await this.deps.store.saveStep(runningStep, step.version);
    if (!stepSaved) {
      await this.deps.leases.revoke(lease.id, this.workerId);
      return "retryable";
    }

    const { signal, timer } = this.cancellation.childSignal(
      run.id,
      run.tenantId,
      this.workerId,
      deadlineAt,
      now,
    );

    try {
      const job = (await this.deps.store.getJob(run.tenantId, run.jobId))!;

      const execution: StepExecution = {
        step: runningStep,
        task,
        job,
        lease,
        correlationId: run.id,
        idempotencyKey: idemKey(
          run.tenantId,
          `${run.id}:${step.id}:${step.attempt}`,
          "step",
        ),
        deadlineMs: deadlineAt - now,
      };

      const result: StepResult = await this.deps.executor.execute(
        execution,
        signal,
      );

      if (result.error) {
        const failResult = await this.scheduler.failStep(runningStep, {
          ...result.error,
          createdAt: this.deps.clock.now(),
        });
        return failResult.success && failResult.retryable !== false
          ? "retryable"
          : "failed";
      }

      await this.scheduler.completeStep(
        runningStep.id,
        result.output,
        result.usage,
        this.workerId,
        lease.id,
        lease.version,
      );

      return "completed";
    } catch {
      return "failed";
    } finally {
      timer.clear();
      await this.deps.leases.revoke(lease.id, this.workerId);
    }
  }

  /**
   * Retry a task: bump attempt, create a new step, return the updated task.
   * The new step gets a deterministic id based on (taskId, nextAttempt).
   */
  private async retryTask(
    task: Task,
    run: Run,
    deadlineAt: number,
  ): Promise<Task | null> {
    const now = this.deps.clock.now();
    const nextAttempt = task.attempt + 1;

    const stepId = createDurableStepId(task.id, nextAttempt);
    const step: Step = {
      id: stepId,
      runId: task.runId,
      taskId: task.id,
      tenantId: run.tenantId,
      attempt: nextAttempt,
      taskIdRef: task.spec.id,
      status: "created",
      createdAt: now,
      version: 0,
      deadlineAt,
    };
    await this.deps.store.saveStep(step, 0);

    const updatedTask: Task = {
      ...task,
      attempt: nextAttempt,
      currentStepId: step.id,
      status: "queued",
      version: task.version + 1,
      startedAt: now,
    };
    await this.deps.store.saveTask(task.id, updatedTask);
    return updatedTask;
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
   * Phase 4.3 verification step. When a verifier and sandbox supplier are
   * configured, provisions a sandbox and runs the default verification checks
   * (output-present, no-error, typecheck, tests, lint, no-uncommitted-changes).
   * Returns `undefined` when verification is not configured (the run is
   * considered passed in that case).
   */
  private async runVerification(
    run: Run,
  ): Promise<VerificationResult | undefined> {
    if (!this.verifier || !this.sandboxSupplier) {
      return undefined;
    }

    const tasks: Task[] = [];
    for (const taskId of run.taskIds) {
      const task = await this.deps.store.getTask(taskId);
      if (task) tasks.push(task);
    }

    // Collect task outcomes for verification. We consider any task that is
    // not in a terminal error state as a candidate for verification output.
    const outcomes = tasks
      .filter(
        (t) =>
          t.status === "completed" ||
          t.status === "queued" ||
          t.status === "running",
      )
      .map((t) => ({
        taskId: t.id,
        status: (t.status === "completed"
          ? "completed"
          : "running") as TaskStatus,
        success: true,
        attempts: t.attempt,
        output: undefined,
        usage: undefined,
      }));

    if (outcomes.length === 0) {
      return {
        passed: false,
        evidence: [
          {
            name: "no-tasks-completed",
            passed: false,
            detail: "No completed tasks to verify",
            severity: "error",
          },
        ],
        confidence: 0,
        failedChecks: ["no-tasks-completed"],
      };
    }

    // Provision a sandbox for verification.
    let sandbox: Sandbox | undefined;
    try {
      sandbox = await this.sandboxSupplier(run.id, run.tenantId);
    } catch {
      sandbox = undefined;
    }

    const workingDirectory = sandbox?.workingDirectory ?? "/workspace";

    try {
      const result = await this.verifier.verify(
        {
          workingDirectory,
          outcome: outcomes[0]!,
          requirements: [],
          sandbox,
        },
        [],
      );
      return result;
    } catch {
      return {
        passed: false,
        evidence: [
          {
            name: "verifier-error",
            passed: false,
            detail: "Verification backend threw",
            severity: "error",
          },
        ],
        confidence: 0,
        failedChecks: ["verifier-error"],
      };
    } finally {
      if (sandbox) {
        try {
          await sandbox.stop();
        } catch {
          // Best-effort.
        }
      }
    }
  }

  /**
   * Cancel a job durably. Marks cancel_requested on the run and fires the
   * cancellation signal so in-flight steps are aborted.
   */
  async cancel(request: CancelRequest): Promise<CancelResult> {
    const now = this.deps.clock.now();
    const job = await this.deps.store.getJob(request.tenantId, request.jobId);
    if (!job) {
      return { jobId: request.jobId, cancelled: false, alreadyTerminal: false };
    }
    assertAuthorized(request.tenantId, job.tenantId, "cancel job");
    if (isTerminal(job.status)) {
      return { jobId: request.jobId, cancelled: false, alreadyTerminal: true };
    }

    this.cancellation.cancel(
      job.currentRunId!,
      request.tenantId,
      "operator",
      request.reason,
      now,
    );

    const run = job.currentRunId
      ? await this.deps.store.getRun(job.currentRunId)
      : undefined;
    if (run) {
      if (runCanTransition(run.status, "cancel_requested")) {
        await this.deps.store.transitionRun(
          run.id,
          run.status,
          "cancel_requested",
          {
            expectedVersion: run.version,
            actor: this.workerId,
            source: "DurableWorkflowRuntime.cancel",
            correlationId: run.id,
            reason: request.reason,
          },
        );
      }
      const updatedRun = await this.deps.store.getRun(run.id);
      if (updatedRun && runCanTransition(updatedRun.status, "cancelled")) {
        await this.deps.store.transitionRun(
          updatedRun.id,
          updatedRun.status,
          "cancelled",
          {
            expectedVersion: updatedRun.version,
            actor: this.workerId,
            source: "DurableWorkflowRuntime.cancel",
            correlationId: run.id,
            reason: request.reason,
          },
        );
      }
      const cancelledJob: Job = {
        ...job,
        status: "cancelled",
        updatedAt: now,
        version: job.version + 1,
      };
      await this.deps.store.saveJob(cancelledJob);
    }

    return { jobId: request.jobId, cancelled: true, alreadyTerminal: false };
  }

  async getJob(
    jobId: DurableJobId,
    tenantId: TenantId,
  ): Promise<JobState | undefined> {
    const job = await this.deps.store.getJob(tenantId, jobId);
    if (!job) return undefined;
    assertAuthorized(tenantId, job.tenantId, "get job");
    const run = job.currentRunId
      ? await this.deps.store.getRun(job.currentRunId)
      : undefined;
    if (!run) return undefined;

    const tasks: Task[] = [];
    for (const taskId of run.taskIds) {
      const task = await this.deps.store.getTask(taskId);
      if (task) tasks.push(task);
    }

    const steps: Step[] = [];
    for (const task of tasks) {
      if (task.currentStepId) {
        const step = await this.deps.store.getStep(task.currentStepId);
        if (step) steps.push(step);
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
    const job = await this.deps.store.getJob(tenantId, jobId);
    if (!job) return emptyAsyncIterable<DurableEvent>();
    assertAuthorized(tenantId, job.tenantId, "stream events");
    const run = job.currentRunId
      ? await this.deps.store.getRun(job.currentRunId)
      : undefined;
    if (!run) return emptyAsyncIterable<DurableEvent>();

    const fromSeq = cursor ? (decodeCursor(cursor)?.lastSequence ?? 0) : 0;
    const events = await this.deps.events.replay(run.id, fromSeq);
    return toAsyncIterable(events.map(redactDurableEvent));
  }
}

function encodeCursor(runId: string, seq: number): string {
  return Buffer.from(`${runId}:${seq}`, "utf8").toString("base64url");
}

function decodeCursor(token: string): { lastSequence: number } | undefined {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf(":");
    if (sep === -1) return undefined;
    const seq = Number.parseInt(decoded.slice(sep + 1), 10);
    if (Number.isNaN(seq)) return undefined;
    return { lastSequence: seq };
  } catch {
    return undefined;
  }
}

async function* toAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true, value: undefined as T }),
      };
    },
  };
}

/**
 * Thrown when a submission is rejected due to invalid input (e.g. an
 * objective string that fails validation).
 */
export class SubmissionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionValidationError";
  }
}
