/**
 * Vaulltcore Intelligence — engineering job model.
 *
 * A `Job` is the first-class concept representing an engineering objective.
 * It is an aggregate root with an immutable event history and explicit,
 * validated state transitions. Identity is deterministic (see `ids.ts`);
 * re-submitting the same objective + tenant resumes the same job (idempotency).
 *
 *  Job
 *   ├── objective
 *   ├── repository/context
 *   ├── constraints
 *   ├── capabilities
 *   ├── execution policy + budget
 *   ├── plan (decomposed tasks)
 *   ├── tasks (with attempts, results, outcomes)
 *   ├── verification (evidence-based)
 *   ├── artifacts
 *   └── outcome
 */

import { redactSecrets } from "@vaulltcore/agent";
import type { Budget } from "./budget";
import type { CorrelationId } from "./correlation";
import { type FailureClass, IntelligenceError } from "./errors";
import type { VcoreId } from "./ids";
import type { ExecutionPolicy } from "./policy";

export type JobStatus =
  | "pending"
  | "planning"
  | "running"
  | "verifying"
  | "repairing"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked"
  | "skipped";

/** Immutable, versioned reference to the repository the job operates on. */
export interface RepositoryContext {
  readonly tenantId: string;
  /** Git remote URL or local path. */
  readonly repo: string;
  readonly branch?: string;
  /** Absolute working directory in the sandbox. */
  readonly workingDirectory?: string;
  /** Opaque sandbox state handle (SandboxState duck-typed to avoid a hard
   * provider import path). */
  readonly sandboxState?: Record<string, unknown>;
}

/** Bounds placed on the objective by the caller / tenant. */
export interface ConstraintSet {
  readonly maxFiles?: number;
  readonly forbiddenPaths?: string[];
  readonly requiredPatterns?: string[];
  readonly maxPatchSizeBytes?: number;
  readonly language?: string;
}

export interface TaskSpec {
  readonly id: VcoreId;
  readonly name: string;
  readonly specialist: string;
  readonly dependsOn: VcoreId[];
  readonly input: unknown;
  readonly resourceBudget?: Partial<Budget>;
}

export interface TaskAttempt {
  readonly attempt: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly output?: unknown;
  readonly usage?: Record<string, number>;
  readonly error?: {
    failureClass: string;
    message: string;
    code?: string;
    retryable?: boolean;
  };
}

export interface TaskOutcome {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly success: boolean;
  readonly attempts: number;
  readonly output?: unknown;
  readonly usage?: Record<string, number>;
  readonly error?: {
    failureClass: string;
    message: string;
    code?: string;
    retryable?: boolean;
  };
}

export interface EvidenceItem {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
  readonly severity: "info" | "warning" | "error";
  readonly metadata?: Record<string, unknown>;
}

export interface VerificationResult {
  readonly passed: boolean;
  readonly evidence: EvidenceItem[];
  readonly confidence: number;
  readonly failedChecks: readonly string[];
  readonly recommendedRepair?: {
    specialist: string;
    reason: string;
    input: unknown;
  };
}

export interface JobOutcome {
  readonly status: JobStatus;
  readonly success: boolean;
  readonly reason?: string;
  readonly error?: string;
  readonly completedAt: number;
}

export interface ArtifactRecord {
  readonly id: string;
  readonly taskId: string;
  readonly path: string;
  readonly kind: string;
  readonly sizeBytes?: number;
  readonly checksum?: string;
  readonly createdAt: number;
}

export interface JobSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly objective: string;
  readonly repository?: RepositoryContext;
  readonly constraints: ConstraintSet;
  readonly capabilities: string[];
  readonly policy: ExecutionPolicy;
  readonly budget: Budget;
  readonly status: JobStatus;
  readonly plan?: JobPlanSnapshot;
  readonly tasks: TaskRecord[];
  readonly attempts: TaskAttempt[];
  readonly verification?: VerificationResult;
  readonly artifacts: ArtifactRecord[];
  readonly outcome?: JobOutcome;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface JobPlanSnapshot {
  readonly taskIds: readonly string[];
  readonly order: readonly string[];
  readonly tasks: readonly TaskSpec[];
}

/** Summary of a plan emitted in `job.planned` events. */
export interface JobPlanSummary {
  readonly taskIds: readonly string[];
  readonly specialistByTask: readonly {
    taskId: string;
    specialist: string;
  }[];
}

export interface TaskRecord {
  readonly spec: TaskSpec;
  status: TaskStatus;
  attempts: TaskAttempt[];
  output?: unknown;
  result?: TaskOutcome;
  startedAt?: number;
  completedAt?: number;
  /** Correlation for the current active attempt. */
  activeCorrelation?: CorrelationId;
}

const VALID_JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  pending: ["planning", "cancelled", "failed"],
  planning: ["running", "cancelled", "failed"],
  running: ["verifying", "repairing", "completed", "failed", "cancelled"],
  verifying: ["completed", "failed", "repairing", "cancelled"],
  repairing: ["verifying", "running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const VALID_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["ready", "skipped", "cancelled", "failed"],
  ready: ["running", "skipped", "cancelled", "failed"],
  running: ["completed", "failed", "cancelled", "blocked", "running"],
  completed: [],
  failed: ["running"],
  blocked: ["running", "skipped", "cancelled", "failed"],
  skipped: [],
  cancelled: [],
};

/** Whether a state transition is allowed by the job state machine. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return VALID_JOB_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Aggregate root for a job. Holds authoritative mutable state and validates
 * every transition. The companion `MemoryEventLog` is the durable record of
 * *how* this state was reached (event sourcing). The aggregate itself is the
 * in-memory projection; it can be reconstructed from logged events.
 */
export class JobAggregate {
  readonly id: string;
  readonly tenantId: string;
  readonly objective: string;
  readonly repository?: RepositoryContext;
  readonly constraints: ConstraintSet;
  readonly capabilities: string[];
  readonly policy: ExecutionPolicy;
  readonly budget: Budget;

  private _status: JobStatus = "pending";
  private _plan?: JobPlanSnapshot;
  private _tasks = new Map<string, TaskRecord>();
  private _attempts: TaskAttempt[] = [];
  private _verification?: VerificationResult;
  private _artifacts: ArtifactRecord[] = [];
  private _outcome?: JobOutcome;
  private _createdAt: number;
  private _updatedAt: number;

  constructor(params: {
    id: string;
    tenantId: string;
    objective: string;
    policy: ExecutionPolicy;
    repository?: RepositoryContext;
    constraints?: ConstraintSet;
    capabilities?: string[];
    budget?: Budget;
    createdAt?: number;
  }) {
    this.id = params.id;
    this.tenantId = params.tenantId;
    this.objective = params.objective;
    this.policy = params.policy;
    this.repository = params.repository;
    this.constraints = params.constraints ?? {};
    this.capabilities = params.capabilities ?? [];
    this.budget = params.budget ?? zeroBudget();
    this._createdAt = params.createdAt ?? Date.now();
    this._updatedAt = this._createdAt;
  }

  get status(): JobStatus {
    return this._status;
  }
  get plan(): JobPlanSnapshot | undefined {
    return this._plan;
  }
  get tasks(): TaskRecord[] {
    return [...this._tasks.values()];
  }
  get attempts(): TaskAttempt[] {
    return [...this._attempts];
  }
  get verification(): VerificationResult | undefined {
    return this._verification;
  }
  get artifacts(): ArtifactRecord[] {
    return [...this._artifacts];
  }
  get outcome(): JobOutcome | undefined {
    return this._outcome;
  }
  get createdAt(): number {
    return this._createdAt;
  }
  get updatedAt(): number {
    return this._updatedAt;
  }

  private touch(): void {
    this._updatedAt = Date.now();
  }

  /** Transition the job status. Throws on invalid transitions. */
  setStatus(status: JobStatus, _reason?: string): void {
    if (!canTransition(this._status, status)) {
      throw new IntelligenceError(
        "configuration",
        `Invalid job status transition ${this._status} → ${status}`,
        {
          correlation: { tenant: this.tenantId, job: this.id },
          metadata: {
            code: "job.transition.invalid",
            from: this._status,
            to: status,
          },
        },
      );
    }
    this._status = status;
    this.touch();
  }

  /** Attach a decomposed plan. Idempotent: setting the same plan is a no-op. */
  setPlan(plan: JobPlanSnapshot): void {
    this._plan = plan;
    for (const task of plan.tasks) {
      if (!this._tasks.has(task.id)) {
        this._tasks.set(task.id, {
          spec: task,
          status: "pending",
          attempts: [],
        });
      }
    }
    this.touch();
  }

  /** Resolve a task by id. */
  getTask(taskId: string): TaskRecord | undefined {
    return this._tasks.get(taskId);
  }

  /** Mark a task ready (dependencies resolved). */
  markTaskReady(taskId: string, correlation?: CorrelationId): void {
    const task = this._tasks.get(taskId);
    if (!task) {
      throw missingTaskError(taskId, this.id, this.tenantId);
    }
    if (task.status !== "pending") {
      return;
    }
    this.ensureTaskTransition(task, "ready");
    task.activeCorrelation = correlation;
    this.touch();
  }

  /** Record a task attempt. */
  recordAttempt(taskId: string, attempt: TaskAttempt): void {
    const task = this._tasks.get(taskId);
    if (!task) {
      throw missingTaskError(taskId, this.id, this.tenantId);
    }
    task.attempts.push(attempt);
    this._attempts.push(attempt);
    this.touch();
  }

  /** Transition a task to a terminal/running status. */
  setTaskStatus(taskId: string, status: TaskStatus): void {
    const task = this._tasks.get(taskId);
    if (!task) {
      throw missingTaskError(taskId, this.id, this.tenantId);
    }
    this.ensureTaskTransition(task, status);
    task.status = status;
    if (status === "running") {
      task.startedAt = task.startedAt ?? Date.now();
    }
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "skipped"
    ) {
      task.completedAt = task.completedAt ?? Date.now();
    }
    this.touch();
  }

  /** Set the final result of a task. */
  setTaskResult(
    taskId: string,
    output: unknown,
    usage: Record<string, number>,
  ): void {
    const task = this._tasks.get(taskId);
    if (!task) {
      throw missingTaskError(taskId, this.id, this.tenantId);
    }
    task.output = output;
    task.result = {
      taskId,
      status: task.status,
      success: task.status === "completed",
      attempts: task.attempts.length,
      output,
      usage,
    };
    task.attempts.push({
      attempt: task.attempts.length + 1,
      startedAt: Date.now(),
      output,
      usage,
    });
    this._attempts.push(task.attempts[task.attempts.length - 1]!);
    this.touch();
  }

  /** Attach verification evidence to the job. */
  setVerification(result: VerificationResult): void {
    this._verification = result;
    this.touch();
  }

  /** Record a produced artifact. */
  addArtifact(artifact: Omit<ArtifactRecord, "id" | "createdAt">): void {
    const record: ArtifactRecord = {
      ...artifact,
      id: `art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    };
    this._artifacts.push(record);
    this.touch();
  }

  /** Consume budget toward the job's ceiling. */
  consumeBudget(delta: Partial<Budget>): void {
    this.budget.modelCalls += delta.modelCalls ?? 0;
    this.budget.toolCalls += delta.toolCalls ?? 0;
    this.budget.inputTokens += delta.inputTokens ?? 0;
    this.budget.outputTokens += delta.outputTokens ?? 0;
    this.budget.costUSD += delta.costUSD ?? 0;
    this.budget.runtimeMs += delta.runtimeMs ?? 0;
    this.budget.activeAgents += delta.activeAgents ?? 0;
    this.touch();
  }

  /** Finalize a job as completed. */
  complete(success: boolean, reason?: string): JobOutcome {
    if (this._status !== "verifying" && this._status !== "running") {
      // Allow completing from repairing too.
      if (this._status !== "repairing") {
        throw new IntelligenceError(
          "configuration",
          `Cannot complete job from status ${this._status}`,
          { correlation: { tenant: this.tenantId, job: this.id } },
        );
      }
    }
    this._status = "completed";
    this._outcome = {
      status: "completed",
      success,
      reason,
      completedAt: Date.now(),
    };
    this.touch();
    return this._outcome;
  }

  /** Finalize a job as failed. */
  fail(reason: FailureClass, message: string): JobOutcome {
    if (
      this._status === "completed" ||
      this._status === "failed" ||
      this._status === "cancelled"
    ) {
      throw new IntelligenceError(
        "configuration",
        `Cannot fail job from terminal status ${this._status}`,
        { correlation: { tenant: this.tenantId, job: this.id } },
      );
    }
    this._status = "failed";
    this._outcome = {
      status: "failed",
      success: false,
      reason,
      error: redactForOutcome(message),
      completedAt: Date.now(),
    };
    this.touch();
    return this._outcome;
  }

  /** Cancel a job (propagates to tasks). */
  cancel(reason: string): JobOutcome {
    if (
      this._status === "completed" ||
      this._status === "failed" ||
      this._status === "cancelled"
    ) {
      // Idempotent cancel on terminal states is allowed.
      if (this._status === "cancelled") {
        return this._outcome ?? this.makeCancelled(reason);
      }
      throw new IntelligenceError(
        "configuration",
        `Cannot cancel job from terminal status ${this._status}`,
        {
          correlation: { tenant: this.tenantId, job: this.id },
          isCancellation: true,
        },
      );
    }
    this._status = "cancelled";
    this._outcome = this.makeCancelled(reason);
    for (const task of this._tasks.values()) {
      if (task.status !== "completed" && task.status !== "cancelled") {
        try {
          this.setTaskStatus(task.spec.id, "cancelled");
        } catch {
          // best-effort cascade
        }
      }
    }
    this.touch();
    return this._outcome;
  }

  private makeCancelled(reason: string): JobOutcome {
    return {
      status: "cancelled",
      success: false,
      reason,
      completedAt: Date.now(),
    };
  }

  private ensureTaskTransition(task: TaskRecord, status: TaskStatus): void {
    if (!canTaskTransition(task.status, status)) {
      throw new IntelligenceError(
        "configuration",
        `Invalid task status transition ${task.status} → ${status}`,
        {
          correlation: { tenant: this.tenantId, job: this.id },
          metadata: {
            code: "task.transition.invalid",
            taskId: task.spec.id,
            from: task.status,
            to: status,
          },
        },
      );
    }
  }

  snapshot(): JobSnapshot {
    return {
      id: this.id,
      tenantId: this.tenantId,
      objective: this.objective,
      repository: this.repository,
      constraints: this.constraints,
      capabilities: [...this.capabilities],
      policy: this.policy,
      budget: { ...this.budget },
      status: this._status,
      plan: this._plan
        ? {
            taskIds: [...this._plan.taskIds],
            order: [...this._plan.order],
            tasks: [...this._plan.tasks],
          }
        : undefined,
      tasks: this.tasks.map((t) => ({
        spec: t.spec,
        status: t.status,
        attempts: [...t.attempts],
        output: t.output,
        result: t.result,
      })),
      attempts: [...this._attempts],
      verification: this._verification,
      artifacts: [...this._artifacts],
      outcome: this._outcome,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }

  /** Reconstruct an aggregate from logged events (event-sourcing). */
  static reconstruct(snapshot: JobSnapshot): JobAggregate {
    const aggregate = new JobAggregate({
      id: snapshot.id,
      tenantId: snapshot.tenantId,
      objective: snapshot.objective,
      policy: snapshot.policy,
      repository: snapshot.repository,
      constraints: snapshot.constraints,
      capabilities: snapshot.capabilities,
      budget: { ...snapshot.budget },
      createdAt: snapshot.createdAt,
    });
    aggregate._status = snapshot.status;
    aggregate._plan = snapshot.plan
      ? {
          taskIds: [...snapshot.plan.taskIds],
          order: [...snapshot.plan.order],
          tasks: [...snapshot.plan.tasks],
        }
      : undefined;
    aggregate._tasks.clear();
    for (const t of snapshot.tasks) {
      aggregate._tasks.set(t.spec.id, {
        spec: t.spec,
        status: t.status,
        attempts: [...t.attempts],
        output: t.output,
        result: t.result,
      });
    }
    aggregate._attempts = [...snapshot.attempts];
    aggregate._verification = snapshot.verification;
    aggregate._artifacts = [...snapshot.artifacts];
    aggregate._outcome = snapshot.outcome;
    aggregate._createdAt = snapshot.createdAt;
    aggregate._updatedAt = snapshot.updatedAt;
    return aggregate;
  }
}

function missingTaskError(
  taskId: string,
  jobId: string,
  tenantId: string,
): IntelligenceError {
  return new IntelligenceError(
    "configuration",
    `Unknown task '${taskId}' for job '${jobId}'`,
    {
      correlation: { tenant: tenantId, job: jobId },
      metadata: { code: "task.unknown", taskId },
    },
  );
}

function zeroBudget(): Budget {
  return {
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    runtimeMs: 0,
    activeAgents: 0,
  };
}

function redactForOutcome(message: string): string {
  return redactSecrets(message);
}
