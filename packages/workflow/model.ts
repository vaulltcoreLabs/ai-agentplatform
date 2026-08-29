/**
 * Vaulltcore Durable Execution — domain model.
 *
 * The durable hierarchy:
 *
 *   Job     — the durable user-level engineering objective (maps to a Phase 3
 *             `JobAggregate`; the durable layer adds run-versioning and
 *             execution metadata).
 *   Run     — one execution attempt/version of a job. A run is created each
 *             time the job moves through the planner → scheduler → execute →
 *             verify → complete cycle. Multiple runs accumulate as a job is
 *             retried or repaired.
 *   Task    — a node from the Phase 3 execution graph. In the durable layer a
 *             task is the unit whose *completion* (across all its steps) the
 *             scheduler tracks.
 *   Step    — a recoverable unit of execution. A single task may require
 *             multiple steps (e.g. an initial attempt that fails and a retry
 *             attempt). Each step is individually leased, checkpointed, and
 *             fenced, so a crash mid-task only loses the in-flight step.
 *
 * Identity is deterministic where the result is content-addressable (job id,
 * task id, step id), and random where it is an ephemeral runtime handle (run
 * version, lease id, event id).
 */

import type { FailureClass } from "@vaulltcore/intelligence";
import type {
  DurableJobId,
  DurableRunId,
  DurableStepId,
  DurableTaskId,
  IdempotencyKey,
  TenantId,
  WorkerId,
} from "./identity";
import type { RunStatus, StepStatus } from "./status";

/**
 * Structured representation of *why* and *how* a step failed, derived from the
 * Phase 3 failure classification. The `retryable` flag is the durable layer's
 * signal for whether a retry should be scheduled.
 */
export interface FailureRecord {
  readonly failureClass: FailureClass;
  readonly retryable: boolean;
  readonly message: string;
  readonly code?: string;
  readonly createdAt: number;
}

/**
 * Hierarchical budget applied to a run, derived from the Phase 3
 * `ExecutionPolicy`. Enforced by `deadlines.ts`.
 */
export interface RunBudget {
  readonly maxRuntimeMs: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Checkpoint captures the recoverable state of a step at a durable boundary.
 * It lets the runtime resume without restarting from zero and lets the
 * verification layer know what evidence already exists.
 *
 * Checkpoints intentionally store *references* and structured metadata, not
 * arbitrary large model contexts.
 */
export interface Checkpoint {
  readonly id: string;
  readonly runId: DurableRunId;
  readonly taskId: DurableTaskId;
  readonly stepId: DurableStepId;
  /** Monotonic sequence within the step. 0 = initial, N = resume point. */
  readonly sequence: number;
  /** Snapshot of the durable state at checkpoint time. */
  readonly state: Record<string, unknown>;
  /** References to evidence/artifact produced so far (not the bytes themselves). */
  readonly evidence: readonly string[];
  /** The attempt this checkpoint belongs to. */
  readonly attempt: number;
  readonly createdAt: number;
}

/**
 * A durable transition record. Every state change is captured with enough
 * context to be replay-safe and auditable.
 */
export interface DurableTransition {
  readonly resource: "job" | "run" | "task" | "step";
  readonly resourceId: string;
  readonly from: string;
  readonly to: string;
  readonly actor: string;
  readonly source: string;
  readonly timestamp: number;
  readonly correlationId: string;
  readonly idempotencyKey?: IdempotencyKey;
  readonly version: number;
  readonly reason?: string;
}

/**
 * A single durable step — the atomic, leasable unit of execution.
 */
export interface Step {
  readonly id: DurableStepId;
  readonly runId: DurableRunId;
  readonly taskId: DurableTaskId;
  readonly tenantId: TenantId;
  /** The attempt number for this step within its task (1-based). */
  readonly attempt: number;
  /** The Phase 3 task id this step executes, or a repair sub-step id. */
  readonly taskIdRef: string;
  readonly status: StepStatus;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** Fencing token: only the owner of this attempt/version may commit. */
  readonly version: number;
  readonly lastError?: FailureRecord;
  readonly output?: unknown;
  readonly usage?: Record<string, number>;
  /** Deadline for this step (epoch ms). */
  readonly deadlineAt?: number;
  /** Cancellation requested at (epoch ms) or null. */
  readonly cancelRequestedAt?: number;
}

/**
 * A durable task — a node from the Phase 3 graph, tracked with per-attempt
 * step history and an aggregate status derived from its steps.
 */
export interface Task {
  readonly id: DurableTaskId;
  readonly runId: DurableRunId;
  readonly jobId: DurableJobId;
  readonly spec: DurableTaskSpec;
  readonly status: StepStatus;
  readonly attempt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly lastError?: FailureRecord;
  readonly completedSteps: readonly DurableStepId[];
  readonly version: number;
  readonly currentStepId?: DurableStepId;
  readonly deadlineAt?: number;
  readonly cancelRequestedAt?: number;
}

/**
 * Re-declaration of the Phase 3 `TaskSpec` so the durable layer does not import
 * the Phase 3 module type as a structural dependency (keeps the domain module
 * framework-free). In practice this is the same shape.
 */
export interface DurableTaskSpec {
  readonly id: string;
  readonly name: string;
  readonly specialist: string;
  readonly dependsOn: readonly string[];
  readonly input: unknown;
}

/**
 * A durable run — one execution attempt of a job. Contains the tasks, the
 * active step set, and the run-level state machine.
 */
export interface Run {
  readonly id: DurableRunId;
  readonly jobId: DurableJobId;
  readonly tenantId: TenantId;
  readonly version: number;
  readonly status: RunStatus;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly taskIds: readonly DurableTaskId[];
  readonly leasedStepIds: readonly DurableStepId[];
  readonly reason?: string;
  readonly lastError?: FailureRecord;
  /** Version used for compare-and-swap on the run row. */
  readonly versionToken: number;
  readonly budget: RunBudget;
  readonly deadlineAt?: number;
  /**
   * Accumulated execution usage for the run. The budget engine enforces
   * `budget` against these counters; breach yields a deterministic
   * `budget_exhausted` terminal classification.
   */
  readonly usage?: RunUsage;
}

/**
 * Accumulated, run-scoped usage counters. Mutated only by the budget engine
 * under a CAS guard so concurrent workers cannot double-count.
 */
export interface RunUsage {
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Wall-clock ms spent in step execution for this run. */
  readonly executionMs: number;
}

/**
 * A durable job — the top-level aggregate. Wraps the Phase 3 `JobAggregate`
 * identity and adds durable execution metadata: how many runs have been
 * attempted, whether cancellation is in flight, and tenant scoping.
 */
export interface Job {
  readonly id: DurableJobId;
  readonly tenantId: TenantId;
  readonly objective: string;
  readonly status: RunStatus;
  readonly runCount: number;
  readonly currentRunId?: DurableRunId;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly reason?: string;
  readonly lastError?: FailureRecord;
  readonly version: number;
}

/**
 * A lease binds a step to a worker for a bounded interval. A lease is the
 * fencing primitive: only the lease holder whose `attempt`/`version` is
 * current may commit a step result.
 */
export interface Lease {
  readonly id: string;
  readonly stepId: DurableStepId;
  /** The worker that currently holds the lease. */
  readonly owner: WorkerId;
  /** Monotonically increasing attempt counter for this step. */
  readonly attempt: number;
  /** Wall-clock expiration. Stale workers cannot extend past this. */
  readonly expiresAt: number;
  /** Last heartbeat timestamp from the owner. */
  readonly heartbeatAt: number;
  /** Fencing token: only the holder of this lease id may commit. */
  readonly version: number;
  readonly createdAt: number;
  /** Epoch ms the lease was revoked, or null if still active. */
  readonly revokedAt: number | null;
}

/**
 * A durable, ordered, append-only event. Extends the Phase 3
 * `IntelligenceEvent` with an explicit `eventId`, `causationId`, and
 * idempotency so delivery ordering is never assumed from transport.
 */
export interface DurableEvent {
  readonly eventId: string;
  readonly runId: DurableRunId;
  readonly sequence: number;
  readonly type: string;
  readonly timestamp: number;
  readonly tenantId: TenantId;
  readonly causationId?: string;
  readonly correlationId: string;
  /** Idempotency key: duplicate delivery within the same key is collapsed. */
  readonly idempotencyKey?: IdempotencyKey;
  readonly payload: Record<string, unknown>;
}

/**
 * A step execution request produced when the scheduler releases work to a
 * worker. Carries all the durable context a worker needs to execute and
 * commit a step safely.
 */
export interface StepExecution {
  readonly step: Step;
  readonly task: Task;
  readonly job: Job;
  readonly lease: Lease;
  readonly correlationId: string;
  readonly deadlineMs: number;
  /**
   * Deterministic idempotency identity for this step execution, derived from
   * (tenant, job, run, task, step, attempt). Executors SHOULD pass this to any
   * external side-effecting call so that at-least-once redelivery does not
   * duplicate effects.
   */
  readonly idempotencyKey: IdempotencyKey;
}
