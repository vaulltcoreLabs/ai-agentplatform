/**
 * Vaulltcore Durable Execution — provider-neutral contracts.
 *
 * These interfaces are the architectural boundary of Phase 4. They are the
 * *only* types the intelligence layer and control plane ever depend on. No
 * concrete cloud, database, queue, or worker implementation is referenced
 * here.
 *
 * The contracts intentionally declare capability, not mechanism. Each method
 * documents the consistency guarantee it provides (atomicity, uniqueness,
 * compare-and-swap, strong ordering) so an adapter implementation can be
 * evaluated against it without reading source.
 *
 * A deterministic in-memory implementation lives in `stores.ts` for tests and
 * local development. Production deployments provide provider-specific adapters
 * (e.g. Cloudflare Durable Objects, Temporal, Postgres-backed, in-memory).
 */

import type {
  Checkpoint,
  DurableEvent,
  DurableTransition,
  FailureRecord,
  Job,
  Lease,
  Run,
  Step,
  StepExecution,
  Task,
} from "./model";
import type {
  DurableJobId,
  DurableRunId,
  DurableStepId,
  DurableTaskId,
  IdempotencyKey,
  TenantId,
  WorkerId,
} from "./identity";
import type { RunStatus } from "./status";

/**
 * A monotonic clock abstraction. Wall-clock time is used only for lease
 * expiration and deadlines; sequence numbers drive event ordering.
 */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Monotonic duration in milliseconds (immune to clock skew). */
  monotonicMs(): number;
}

/**
 * Durable, tenant-partitioned storage for Job / Run / Task / Step records.
 *
 * Consistency requirements per operation:
 *  - `createJob`: uniqueness on (tenantId, jobId); atomic.
 *  - `saveStep`: compare-and-swap on `version` to enforce fencing.
 *  - `transition`: atomic read-modify-write guarded by `expectedVersion`.
 *  - cross-resource updates (e.g. complete-step + advance-task) must be
 *    transactional: either all apply or none.
 */
export interface WorkflowStore {
  saveJob(
    job: Job,
    opts?: { idempotencyKey?: IdempotencyKey },
  ): Promise<boolean>;
  getJob(tenantId: TenantId, jobId: DurableJobId): Promise<Job | undefined>;
  resolveJobTenant(jobId: DurableJobId): Promise<TenantId | undefined>;
  claimJob(jobId: DurableJobId, worker: WorkerId): Promise<boolean>;

  /** Persist a checkpoint for recovery/verification. */
  saveCheckpoint(checkpoint: Checkpoint): Promise<boolean>;

  /**
   * Atomically persist a durable cancellation marker for a run. A marker is the
   * authoritative, crash-surviving signal that work for the run must stop.
   * Workers poll this marker; it is the only cancellation source of truth in a
   * multi-process deployment (the in-memory `CancellationHub` is a cache of it).
   */
  setCancellationMarker(
    runId: DurableRunId,
    tenantId: TenantId,
    requestedBy: string,
    reason: string,
    requestedAt: number,
  ): Promise<void>;
  /** Read the durable cancellation marker for a run, if any. */
  getCancellationMarker(
    runId: DurableRunId,
  ): Promise<
    { requestedBy: string; reason: string; requestedAt: number } | undefined
  >;

  saveRun(
    run: Run,
    opts?: { idempotencyKey?: IdempotencyKey },
  ): Promise<boolean>;
  getRun(runId: DurableRunId): Promise<Run | undefined>;
  getRunByJobAndVersion(
    jobId: DurableJobId,
    version: number,
  ): Promise<Run | undefined>;
  /** Mark the run terminal with a CAS guard on `expectedVersion`. */
  transitionRun(
    runId: DurableRunId,
    from: RunStatus,
    to: RunStatus,
    opts: {
      expectedVersion: number;
      actor: string;
      source: string;
      reason?: string;
      correlationId?: string;
      idempotencyKey?: IdempotencyKey;
    },
  ): Promise<DurableTransition | null>;

  saveTask(taskId: DurableTaskId, task: Task): Promise<boolean>;
  getTask(taskId: DurableTaskId): Promise<Task | undefined>;
  /** Persist a step with fencing: only succeeds if `step.version === expectedVersion`. */
  saveStep(step: Step, expectedVersion: number): Promise<boolean>;
  getStep(stepId: DurableStepId): Promise<Step | undefined>;

  /**
   * Enumerate run ids that are NOT in a terminal state. Used by the
   * reconciliation loop to rediscover work whose queue message was lost, never
   * produced, or whose producing worker died before re-enqueuing. A run is
   * "active" when its status is queued/running/verifying/cancel_requested.
   * Provider-neutral: a real adapter scans the runs table with a status filter.
   */
  listActiveRunIds(tenantId?: TenantId): Promise<readonly DurableRunId[]>;

  /** Record a durable transition for audit/replay. */
  recordTransition(transition: DurableTransition): Promise<void>;
  getTransitions(
    resource: string,
    since?: number,
  ): Promise<DurableTransition[]>;
}

/**
 * Lease storage for task/step claiming. Implements the CAS-based claim pattern
 * used throughout the existing web codebase (`claimSessionLifecycleRunId`,
 * `claimChatActiveStreamId`). Each claim is an atomic UPDATE … WHERE
 * <guard> RETURNING.
 */
export interface TaskLeaseStore {
  /** Atomically claim a lease on `stepId` for `owner`. Returns the lease. */
  claim(
    stepId: DurableStepId,
    owner: WorkerId,
    ttlMs: number,
  ): Promise<Lease | null>;
  /** Renew a lease you own (fenced by lease id). */
  renew(leaseId: string, owner: WorkerId, ttlMs: number): Promise<boolean>;
  /** Revoke a lease (on completion, cancellation, or expiry). */
  revoke(leaseId: string, owner: WorkerId): Promise<void>;
  /** Return a lease if its `expiresAt` is in the past. */
  getLease(stepId: DurableStepId): Promise<Lease | null>;
  /** All leases whose owner == `owner` (for heartbeat maintenance). */
  getLeasesForWorker(owner: WorkerId): Promise<Lease[]>;
  /** All leases that have expired (for a reclaimer). */
  getExpiredLeases(now: number): Promise<Lease[]>;
}

/**
 * An append-only, strongly-ordered event store.
 *
 * Ordering guarantee: within a run, `sequence` is strictly monotonic and
 * immutable. Cross-run events are ordered by the store's commit log.
 * Idempotency: duplicate appends of the same `(runId, idempotencyKey)` are
 * collapsed to the first occurrence.
 */
export interface EventStore {
  append(
    event: Omit<DurableEvent, "eventId" | "sequence" | "timestamp"> & {
      readonly idempotencyKey?: IdempotencyKey;
    },
  ): Promise<DurableEvent>;
  /** Replay events for a run in sequence order. */
  replay(runId: DurableRunId, fromSequence?: number): Promise<DurableEvent[]>;
  /** Monotonic count of events for a run. */
  count(runId: DurableRunId): number;
}

/**
 * Checkpoint storage. Each checkpoint is immutable once written (append-only
 * within a step). Recovery resumes from the highest-sequence checkpoint for
 * the step.
 */
export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<boolean>;
  /** Checkpoints for a step, in sequence order. */
  listForStep(stepId: DurableStepId): Promise<Checkpoint[]>;
  latestForStep(stepId: DurableStepId): Promise<Checkpoint | null>;
  /** Checkpoint count for observability. */
  count(): number;
}

/**
 * Composite queue message identity (Phase 5 §15).
 *
 * Tenant identity is STRUCTURAL: every queue operation addresses messages by
 * `(tenantId, messageId)`, never by bare messageId. This makes cross-tenant
 * access unrepresentable at the type level — a caller cannot address another
 * tenant's message without explicitly supplying that tenant's ID, and storage
 * engines partition by the composite key.
 */
export interface QueuedMessageRef {
  readonly tenantId: TenantId;
  readonly messageId: string;
}

/**
 * Provider-neutral queue contract. Supports at-least-once delivery semantics
 * with a visibility-timeout/lease so crashed workers do not lose work.
 *
 * Phase 5 §11 behavioral requirement on implementations: `claim` cost must
 * not grow linearly with the number of irrelevant visible messages. Backends
 * satisfying this via set-based claims (e.g. FOR UPDATE SKIP LOCKED) are the
 * production reference; primitive-composed backends remain correct but are
 * not scalability-qualified.
 */
export interface Queue {
  enqueue(
    ref: QueuedMessageRef,
    payload: unknown,
    opts?: {
      delayMs?: number;
      priority?: number;
      idempotencyKey?: IdempotencyKey;
    },
  ): Promise<boolean>;
  /**
   * Atomically claim a batch of visible messages. Claimed messages are
   * invisible until acknowledged, expired, or dead-lettered.
   */
  claim(
    workerId: WorkerId,
    maxMessages: number,
    visibilityTimeoutMs: number,
  ): Promise<QueuedMessage[]>;
  /** Ack a claimed message so it is removed. Stale/wrong-tenant acks fail. */
  ack(ref: QueuedMessageRef, workerId: WorkerId): Promise<boolean>;
  /** Requeue a claimed message for later delivery (retry). */
  retry(ref: QueuedMessageRef, delayMs?: number): Promise<boolean>;
  /** Move a message to the dead-letter queue. */
  deadLetter(ref: QueuedMessageRef, reason: string): Promise<boolean>;
  stats(): Promise<QueueStats>;
}

export interface QueuedMessage extends QueuedMessageRef {
  readonly payload: unknown;
  readonly priority: number;
  readonly enqueuedAt: number;
  readonly availableAt: number;
  readonly attempt: number;
  readonly receivedCount: number;
}

export interface QueueStats {
  readonly visible: number;
  readonly inflight: number;
  readonly delayed: number;
  readonly deadLettered: number;
}

/**
 * The durable execution boundary that the intelligence layer's
 * `SpecialistRunner` plugs into. A `StepExecutor` runs one step to completion
 * (or failure) and returns the structured result; the runtime is responsible
 * for leasing, fencing, checkpointing, and retries around this call.
 */
export interface StepExecutor {
  /**
   * Execute a single step. The `signal` carries both the run-level cancellation
   * and the step deadline. Must not be called without holding a valid lease.
   */
  execute(execution: StepExecution, signal: AbortSignal): Promise<StepResult>;
}

export interface StepResult {
  readonly output: unknown;
  readonly usage: Record<string, number>;
  readonly error?: FailureRecord;
  readonly artifacts: readonly unknown[];
  /** Sequence of checkpoint hints the executor produced during the run. */
  readonly checkpoints?: readonly Partial<Checkpoint>[];
  /**
   * The idempotency key the executor actually used for external side effects,
   * if any. Persisted on the step record for audit and replay.
   */
  readonly idempotencyKey?: IdempotencyKey;
}

/**
 * Idempotency enforcement. Records that an operation was performed under a
 * given key and returns the prior result on duplicate submission.
 */
export interface IdempotencyStore {
  /**
   * Record a successful outcome. Returns `false` if the key was already
   * recorded by a *different* operation (conflict) or if it was already
   * recorded with the same operation (duplicate — caller should read back).
   */
  record(
    key: IdempotencyKey,
    operation: string,
    result: unknown,
  ): Promise<"recorded" | "duplicate" | "conflict">;
  /** Look up a previously recorded outcome. */
  get(key: IdempotencyKey): Promise<IdempotencyRecord | undefined>;
}

export interface IdempotencyRecord {
  readonly key: IdempotencyKey;
  readonly operation: string;
  readonly result: unknown;
  readonly recordedAt: number;
}

/**
 * The durable workflow runtime: the facade the control plane uses. It owns the
 * lifecycle of a job from durable submission to terminal state, delegating to
 * the intelligence layer for planning and the sandbox/agent engine for
 * execution.
 */
export interface WorkflowRuntime {
  /**
   * Submit a job for durable execution. Idempotent: the same
   * (tenantId, objective) + idempotency key resumes an existing job rather
   * than duplicating it.
   */
  submit(request: SubmitRequest): Promise<SubmitResult>;
  /** Cancel a job durably. Returns immediately; cancellation propagates. */
  cancel(request: CancelRequest): Promise<CancelResult>;
  /** Resume the durable state of a job for reconnection / recovery. */
  getJob(
    jobId: DurableJobId,
    tenantId: TenantId,
  ): Promise<JobState | undefined>;
  /** Get the durable event stream for a job, with cursor resume. */
  streamEvents(
    jobId: DurableJobId,
    tenantId: TenantId,
    cursor?: string,
  ): Promise<AsyncIterable<DurableEvent>>;
}

export interface SubmitRequest {
  readonly tenantId: TenantId;
  readonly objective: string;
  readonly idempotencyKey?: IdempotencyKey;
  readonly policyOverride?: Record<string, unknown>;
  /**
   * Optional explicit execution plan. When supplied it overrides the runtime's
   * default single-task plan. The DAG is validated before any durable state is
   * created; an invalid DAG (cycle, unknown dependency, self-loop) is rejected.
   */
  readonly dag?: import("./dag").DagSpec;
}

export interface SubmitResult {
  readonly jobId: DurableJobId;
  readonly runId: DurableRunId;
  readonly status: RunStatus;
  /** True when this submission created a new run vs. resumed an existing one. */
  readonly createdRun: boolean;
}

export interface CancelRequest {
  readonly tenantId: TenantId;
  readonly jobId: DurableJobId;
  readonly reason: string;
}

export interface CancelResult {
  readonly jobId: DurableJobId;
  readonly cancelled: boolean;
  readonly alreadyTerminal: boolean;
}

/**
 * A snapshot of durable job state returned to callers (e.g. for reconnection).
 * Contains no secrets and is tenant-scoped.
 */
export interface JobState {
  readonly job: Job;
  readonly run: Run;
  readonly tasks: readonly Task[];
  readonly steps: readonly Step[];
  readonly events: readonly DurableEvent[];
  readonly cursor: string;
}

export type { DurableEvent } from "./model";
