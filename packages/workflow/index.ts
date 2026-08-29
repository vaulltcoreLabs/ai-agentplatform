/**
 * Vaulltcore Durable Execution — public API.
 *
 *   Control Plane (Phase 4)
 *        │
 *        ▼
 *   ┌──────────────────┐
 *   │   WORKFLOW       │  (this package)
 *   │   Durable Runtime│
 *   │   Scheduler      │
 *   │   Stores (impl)  │
 *   └────────┬─────────┘
 *        │ durable contracts
 *   ▼───────────────────────
 *   INTELLIGENCE (Phase 3)
 *   ┌────────┬──────────┐
 *   │  AGENT │ SANDBOX  │ (Phase 1–2)
 *   └────────┴──────────┘
 *
 * Public re-exports: identity, statuses, domain model, contracts, store
 * implementations, scheduler, runtime, and utility modules.
 */

// Identity & idempotency
export {
  createDurableJobId,
  createDurableRunId,
  createDurableTaskId,
  createDurableStepId,
  createWorkerId,
  createLeaseId,
  idemKey,
  durableId,
  jobNamespace,
  runNamespace,
  taskNamespace,
  stepNamespace,
} from "./identity";
export type {
  DurableIdNamespace,
  DurableJobId,
  DurableRunId,
  DurableTaskId,
  DurableStepId,
  TenantId,
  WorkerId,
  IdempotencyKey,
} from "./identity";

// Durable statuses & state machine
export {
  isTerminal,
  isActive,
  runCanTransition,
  stepCanTransition,
  runStatusToPhase3Status,
  stepStatusToPhase3Status,
} from "./status";
export type { RunStatus, StepStatus } from "./status";

// Domain model
export type {
  Checkpoint,
  DurableEvent,
  DurableTransition,
  DurableTaskSpec,
  FailureRecord,
  Job,
  Lease,
  Run,
  RunBudget,
  RunUsage,
  Step,
  StepExecution,
  Task,
} from "./model";

// Provider-neutral contracts
export type {
  CheckpointStore,
  Clock,
  EventStore,
  IdempotencyRecord,
  IdempotencyStore,
  JobState,
  Queue,
  QueueStats,
  QueuedMessage,
  QueuedMessageRef,
  StepExecutor,
  StepResult,
  SubmitRequest,
  SubmitResult,
  CancelRequest,
  CancelResult,
  TaskLeaseStore,
  WorkflowRuntime,
  WorkflowStore,
} from "./contracts";

// Clock implementations
export { SystemClock, TestClock } from "./clock";

// In-memory store implementations
export {
  InMemoryWorkflowStore,
  InMemoryTaskLeaseStore,
  InMemoryEventStore,
  InMemoryCheckpointStore,
  InMemoryIdempotencyStore,
  InMemoryQueue,
} from "./stores";

// Scheduler
export { DurableScheduler } from "./scheduler";
export type {
  TaskDescriptor,
  ScheduleResult,
  ReleaseCandidate,
  StepCompletionResult,
  FailResult,
  TaskEvaluation,
} from "./scheduler";

// Retry
export {
  decideRetry,
  linearCongruentialRng,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_MAX_RETRIES,
} from "./retry";
export type {
  RetryDecision,
  RetryContext,
  RetryOptions,
  GiveUpReason,
} from "./retry";

// Deadlines & budget
export {
  initialBudget,
  checkBudget,
  isDeadlineExceeded,
  childDeadline,
  computeRunDeadline,
} from "./deadlines";
export type { BudgetBreach, BudgetState } from "./deadlines";

// Checkpoints
export {
  createCheckpoint,
  deriveResumePoint,
  mergeEvidence,
  isLatestCheckpoint,
  highestAttempt,
} from "./checkpoints";

// Leases
export {
  computeLeaseTtl,
  isLeaseValid,
  shouldRenew,
  verifyFencing,
  toStepLease,
  refreshedLease,
  DEFAULT_LEASE_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  DEFAULT_LEASE_CONFIG,
} from "./leases";
export type { LeaseConfig } from "./leases";

// Cancellation
export { CancellationHub } from "./cancellation";
export type { CancellationState, TimerHandle } from "./cancellation";

// Tenant scoping
export { TenantScope } from "./tenant";
export type { TenantConfig } from "./tenant";

// Security
export {
  validateObjective,
  redactFailure,
  redactDurableEvent,
} from "./security";

// Streaming / cursor
export { encodeCursor, decodeCursor, applyCursor } from "./streaming";
export type { EventCursor, StreamOptions, EventPage } from "./streaming";

// Chaos / failure injection
export {
  ChaosInjector,
  NoopChaosInjector,
  seededRng,
  CrashError,
} from "./chaos";
export type {
  FaultPlan,
  FaultSpec,
  FaultType,
  InjectedFailure,
  InjectedDelay,
} from "./chaos";

// Runtime
export {
  DurableWorkflowRuntime,
  NoopStepExecutor,
  defaultBudget,
} from "./runtime";
export type { DurableRuntimeDeps } from "./runtime";

// Distributed, provider-neutral store adapter (Phase 4.1)
export {
  MemorySharedBackend,
  DistributedWorkflowStore,
  DistributedTaskLeaseStore,
  DistributedEventStore,
  DistributedCheckpointStore,
  DistributedIdempotencyStore,
  DistributedQueue,
  CAS_ABSENT,
} from "./distributed-store";
export type { SharedBackend } from "./distributed-store";

// Authorization gate (F-10)
export {
  AuthorizationError,
  authorize,
  assertAuthorized,
  assertTenantKnown,
} from "./authorization";

// DAG planning (F-7)
export { validateDag, planDag } from "./dag";
export type { DagSpec, DagNodeSpec, PlannedTask } from "./dag";

// Distributed durable worker + runtime (Phase 4.1)
export { DurableWorker, WorkerCrashError } from "./worker";
export type { WorkerDeps, WorkerPhase, WorkerStepResult } from "./worker";
export { DistributedDurableRuntime } from "./distributed-runtime";
export type { DistributedRuntimeDeps } from "./distributed-runtime";

// Sandbox-backed StepExecutor (Phase 4.3)
export { SandboxStepExecutor } from "./sandbox-executor";
export type { SandboxStepExecutorOptions } from "./sandbox-executor";

// Remote runner protocol contracts (Phase 4.5)
export {
  RunnerControlPlane,
  RunnerProtocolError,
  RunnerRegistry,
  RunnerSession,
  canTransition,
} from "./runner-protocol";
export type {
  ExecutionEnvelope,
  RunnerCapability,
  RunnerIdentity,
  RunnerSessionState,
} from "./runner-protocol";
