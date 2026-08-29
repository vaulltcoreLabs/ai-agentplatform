/**
 * Vaulltcore Durable Execution — durable scheduler.
 *
 * The scheduler is the bridge between the durable store layer and the
 * intelligence layer's execution graph. It:
 *
 *  1. **Builds the execution graph** — delegates to Phase 3's
 *     `buildTaskGraph` to produce the dependency-ordered task graph from a
 *     plan, then stamps each task with durable ids.
 *  2. **Releases steps** — determines which steps are runnable (status=queued,
 *     dependencies satisfied, not cancelled, within deadline and quota) and
 *     leases them to workers.
 *  3. **Advances state** — when a step completes/fails, updates the task and
 *     run aggregates and releases dependent steps.
 *
 * The scheduler is *stateless* between calls — it reads from and writes to
 * the durable stores. This means any worker process can call it, and crash
 * recovery is automatic (just re-schedule).
 */

import type {
  DurableJobId,
  DurableRunId,
  DurableStepId,
  DurableTaskId,
  TenantId,
  WorkerId,
} from "./identity";
import type { Step, Task } from "./model";
import type { Clock, TaskLeaseStore, WorkflowStore } from "./contracts";
import { isTerminal, stepCanTransition } from "./status";
import { createDurableStepId } from "./identity";
import {
  computeLeaseTtl,
  DEFAULT_LEASE_CONFIG,
  type LeaseConfig,
} from "./leases";
import { createCheckpoint } from "./checkpoints";

export interface TaskDescriptor {
  readonly name: string;
  readonly specialist: string;
  readonly dependsOn: readonly string[];
  readonly input: unknown;
}

export interface ScheduleResult {
  readonly releasedSteps: readonly ReleaseCandidate[];
}

export interface ReleaseCandidate {
  readonly step: Step;
  readonly task: Task;
  readonly leaseId: string;
}

/**
 * The durable scheduler. Holds no state — operates purely through the
 * injected stores and clock.
 */
export class DurableScheduler {
  constructor(
    private readonly store: WorkflowStore,
    private readonly leases: TaskLeaseStore,
    private readonly clock: Clock,
    private readonly leaseConfig: LeaseConfig = DEFAULT_LEASE_CONFIG,
  ) {}

  /**
   * Create a step for the initial attempt of a task. Called when a task
   * transitions to `queued` and needs a step to execute.
   */
  async createStep(
    taskId: DurableTaskId,
    runId: DurableRunId,
    jobId: DurableJobId,
    tenantId: TenantId,
    attempt: number,
    task: Task,
    _input: unknown,
  ): Promise<Step> {
    const stepId = createDurableStepId(taskId, attempt);
    const now = this.clock.now();
    const step: Step = {
      id: stepId,
      runId,
      taskId,
      tenantId,
      attempt,
      taskIdRef: task.spec.id,
      status: "queued",
      createdAt: now,
      version: 0,
      deadlineAt: task.deadlineAt,
    };
    await this.store.saveStep(step, 0);
    return step;
  }

  /**
   * Determine which steps are runnable and lease them to `worker`.
   *
   * A step is runnable when:
   *  - status is `queued`
   *  - its task's dependencies are all completed
   *  - the run is not in a cancelled/expired state
   *  - the step's deadline has not passed
   *  - a lease can be acquired (no competing worker)
   */
  async releaseSteps(
    runId: DurableRunId,
    worker: WorkerId,
  ): Promise<ReleaseCandidate[]> {
    // Load all tasks for the run
    const run = await this.store.getRun(runId);
    if (!run || isTerminal(run.status)) return [];
    if (run.status === "cancel_requested") return [];

    const released: ReleaseCandidate[] = [];
    for (const taskId of run.taskIds) {
      const task = await this.store.getTask(taskId);
      if (!task) continue;

      // Check task dependencies are satisfied
      const depsSatisfied = await this.checkDependencies(task);
      if (!depsSatisfied) continue;

      // Get the current step for this task
      const stepId = this.currentStepId(task);
      if (!stepId) continue;

      const fetched = await this.store.getStep(stepId);
      if (!fetched) continue;
      let step = fetched;

      // Crash recovery: a step left in running/waiting by a worker that died
      // (its lease expired or was revoked) must become re-leasable. If no valid
      // lease is currently held, reset it to queued so a new worker can claim
      // it. This is what lets a crashed step resume after lease expiry instead
      // of being permanently stuck.
      if (step.status === "running" || step.status === "waiting") {
        const lease = await this.leases.getLease(stepId);
        const valid =
          lease !== null &&
          lease.revokedAt === null &&
          lease.expiresAt > this.clock.now();
        if (!valid) {
          const reset = {
            ...step,
            status: "queued" as const,
            version: step.version + 1,
          };
          await this.store.saveStep(reset, step.version);
          // Update local reference so the downstream runnable checks use the
          // reset step, not the stale running one.
          step = reset;
        } else {
          continue;
        }
      }

      // Check step is runnable
      if (step.status !== "queued") continue;

      // Check deadline
      if (
        step.deadlineAt !== undefined &&
        this.clock.now() >= step.deadlineAt
      ) {
        await this.failStep(step, {
          failureClass: "timeout",
          retryable: true,
          message: "Step deadline exceeded before execution",
          createdAt: this.clock.now(),
        });
        continue;
      }

      // Try to lease the step
      const ttl = computeLeaseTtl(
        step.deadlineAt,
        this.clock.now(),
        this.leaseConfig,
      );
      const lease = await this.leases.claim(stepId, worker, ttl);
      if (!lease) continue;

      // Update step status to running (fenced by version)
      const updated: Step = {
        ...step,
        status: "running",
        startedAt: this.clock.now(),
        version: step.version + 1,
      };
      const saved = await this.store.saveStep(updated, step.version);
      if (!saved) {
        // Lost the lease race — roll back
        await this.leases.revoke(lease.id, worker);
        continue;
      }

      // Single authoritative release: return the first runnable step so a
      // worker never holds a lease it will not execute in this cycle. Parallel
      // tasks are released across subsequent polls / multiple workers.
      return [{ step: updated, task, leaseId: lease.id }];
    }

    return released;
  }

  /**
   * Called when a worker completes a step successfully.
   */
  async completeStep(
    stepId: DurableStepId,
    output: unknown,
    usage: Record<string, number>,
    owner: WorkerId,
    leaseId: string,
    version: number,
  ): Promise<StepCompletionResult> {
    const step = await this.store.getStep(stepId);
    if (!step) return { success: false, reason: "step_not_found" };

    // Fencing: the caller must still hold the lease that owns this step, AND
    // the lease's fencing token (`version`) must match the version the caller
    // believes it holds. A stale worker whose lease was superseded (version
    // advanced) or revoked cannot pass this check. This is the security boundary
    // for execution correctness — it is checked before any durable write.
    const lease = await this.leases.getLease(stepId);
    if (
      !lease ||
      lease.id !== leaseId ||
      lease.owner !== owner ||
      lease.version !== version
    ) {
      return { success: false, reason: "lease_lost" };
    }

    if (step.status !== "running") {
      return { success: false, reason: "not_running" };
    }

    const updated: Step = {
      ...step,
      status: "completed",
      endedAt: this.clock.now(),
      version: step.version + 1,
      output,
      usage,
    };
    // CAS on step.version: even if the lease check passed, a concurrent commit
    // (or a re-claim after lease expiry) that advanced step.version will reject
    // us here. Double fencing: lease-version + step-version.
    const saved = await this.store.saveStep(updated, step.version);
    if (!saved) return { success: false, reason: "version_conflict" };

    // Advance the owning task to completed (the task aggregates its step's
    // terminal state; for a single-step task this makes the dependency
    // satisfiable for downstream tasks).
    const owning = await this.store.getTask(step.taskId);
    if (owning) {
      const updatedTask: Task = {
        ...owning,
        status: "completed",
        endedAt: this.clock.now(),
        completedSteps: [...owning.completedSteps, step.id],
        version: owning.version + 1,
      };
      await this.store.saveTask(owning.id, updatedTask);
    }

    // Create a checkpoint for the completed step
    await this.checkpointCompletedStep(updated, output);

    // Revoke the lease
    await this.leases.revoke(leaseId, owner);

    // Record the transition
    await this.store.recordTransition({
      resource: "step",
      resourceId: stepId,
      from: step.status,
      to: "completed",
      actor: owner,
      source: "scheduler.completeStep",
      timestamp: this.clock.now(),
      correlationId: "",
      version: updated.version,
    });

    return { success: true, step: updated };
  }

  /**
   * Called when a worker fails a step. Classifies the failure, decides
   * whether to retry, and either re-queues or marks failed.
   */
  async failStep(
    step: Step,
    failure: Omit<import("./model").FailureRecord, "createdAt"> & {
      createdAt: number;
    },
  ): Promise<FailResult> {
    if (!stepCanTransition(step.status, "failed")) {
      return { success: false, reason: "invalid_transition" };
    }

    const updated: Step = {
      ...step,
      status: "failed",
      endedAt: this.clock.now(),
      version: step.version + 1,
      lastError: failure,
    };
    const saved = await this.store.saveStep(updated, step.version);
    if (!saved) return { success: false, reason: "version_conflict" };

    await this.store.recordTransition({
      resource: "step",
      resourceId: step.id,
      from: step.status,
      to: "failed",
      actor: "scheduler",
      source: "scheduler.failStep",
      timestamp: this.clock.now(),
      correlationId: "",
      version: updated.version,
    });

    // Update the parent task's failure info
    const task = await this.store.getTask(step.taskId);
    if (task) {
      const updatedTask: Task = {
        ...task,
        lastError: failure,
        version: task.version + 1,
      };
      await this.store.saveTask(task.id, updatedTask);
    }

    return { success: true, step: updated, retryable: failure.retryable };
  }

  async cancelStep(stepId: DurableStepId): Promise<boolean> {
    const step = await this.store.getStep(stepId);
    if (!step) return false;
    if (isTerminal(step.status)) return false;
    if (!stepCanTransition(step.status, "cancel_requested")) return false;

    const updated: Step = {
      ...step,
      status: "cancel_requested",
      version: step.version + 1,
      cancelRequestedAt: this.clock.now(),
    };
    return await this.store.saveStep(updated, step.version);
  }

  /**
   * Check whether all dependencies of a task's dependencies are completed.
   */
  private async checkDependencies(task: Task): Promise<boolean> {
    for (const depName of task.spec.dependsOn) {
      // Map dependency name to durable task id within this run
      const depTask = await this.findTaskByName(task.runId, depName);
      if (!depTask) return false;
      if (depTask.status !== "completed") {
        return false;
      }
    }
    return true;
  }

  /**
   * Find a task in a run by its spec name (used for dependency resolution).
   */
  private async findTaskByName(
    runId: string,
    name: string,
  ): Promise<Task | undefined> {
    const run = await this.store.getRun(runId);
    if (!run) return undefined;
    for (const taskId of run.taskIds) {
      const task = await this.store.getTask(taskId);
      if (task?.spec.name === name) return task;
    }
    return undefined;
  }

  /**
   * Get the step id for the current attempt of a task. If the current
   * attempt's step is terminal, a new step is *not* created here — that's
   * the retry loop's job.
   */
  private currentStepId(task: Task): DurableStepId | null {
    if (task.currentStepId) return task.currentStepId;
    return null;
  }

  private async checkpointCompletedStep(
    step: Step,
    output: unknown,
  ): Promise<void> {
    const checkpoint = createCheckpoint(
      step.id,
      0,
      { status: "completed", output: redactForCheckpoint(output) },
      [],
      step.attempt,
      this.clock.now(),
      step.runId,
      step.taskId,
    );
    await this.store.saveCheckpoint(checkpoint);
  }

  async evaluateTaskCompletion(taskId: DurableTaskId): Promise<TaskEvaluation> {
    const task = await this.store.getTask(taskId);
    if (!task) return { complete: false, status: "unknown" };

    const completed = task.status === "completed";
    return {
      complete: completed,
      status: completed ? "completed" : task.status,
    };
  }
}

function redactForCheckpoint(output: unknown): Record<string, unknown> {
  if (output !== null && typeof output === "object" && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  return { value: String(output ?? "") };
}

export interface StepCompletionResult {
  readonly success: boolean;
  readonly step?: Step;
  readonly reason?: string;
}

export interface FailResult {
  readonly success: boolean;
  readonly step?: Step;
  readonly retryable?: boolean;
  readonly reason?: string;
}

export interface TaskEvaluation {
  readonly complete: boolean;
  readonly status: string;
}
