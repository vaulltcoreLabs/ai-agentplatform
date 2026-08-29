/* eslint-disable oxc/no-barrel-file */
/**
 * Vaulltcore Intelligence — provider-neutral public boundary.
 *
 * This package sits above the Phase 1 Agent Engine and Phase 2 Sandbox:
 *
 *   Vaulltcore Control Plane (Phase 4)
 *            │
 *            ▼
 *   ┌──────────────────────┐
 *   │   INTELLIGENCE       │  (this package)
 *   │   Planning  ·  Policy│
 *   │   Scheduling · Verify│
 *   │   Repair  ·  Memory  │
 *   └──────────┬───────────┘
 *            │ provider-neutral contracts
 *   ┌────────▼───────────┐
 *   │  AGENT ENGINE      │  packages/agent
 *   │  + Subagents       │
 *   └────────┬───────────┘
 *            │
 *   ┌────────▼───────────┐
 *   │  SANDBOX           │  packages/sandbox
 *   │  Docker / Cloud …  │
 *   └────────────────────┘
 */

// IDs & correlation
export {
  createJobId,
  createTaskId,
  deterministicId,
  jobIdNamespace,
  taskInputSignature,
  taskIdNamespace,
  type IdNamespace,
  type VcoreId,
} from "./ids";

export {
  newCorrelation,
  verificationCorrelation,
  withTask,
  type CorrelationId,
} from "./correlation";

export {
  INTELLIGENCE_EVENT_VERSION,
  isIntelligenceEvent,
  MemoryEventLog,
  type EventLog,
  type IntelligenceEvent,
  type IntelligenceEventInit,
  type IntelligenceEventType,
} from "./events";

export {
  applyPolicyOverride,
  DEFAULT_EXECUTION_POLICY,
  type ApprovalPolicy,
  type ExecutionPolicy,
  type NetworkPolicy,
  type PolicyOverride,
  type RetryPolicy,
} from "./policy";

export {
  BudgetTracker,
  budgetExceeded,
  cloneBudget,
  emptyBudget,
  type Budget,
  type BudgetBreach,
  type BudgetKind,
} from "./budget";

export {
  BudgetFailure,
  CancellationFailure,
  classifyError,
  ConfigurationFailure,
  ConflictFailure,
  ContextFailure,
  DependencyFailure,
  IntelligenceError,
  isRecoverable,
  ModelFailure,
  PermissionFailure,
  PlanningFailure,
  SandboxFailure,
  TimeoutFailure,
  ToolFailure,
  type FailureClass,
  type IntelligenceErrorMetadata,
  UnknownFailure,
  VerificationFailure,
  redactSecrets,
  wrapError,
} from "./errors";

export {
  defaultVerifier,
  DefaultVerifier,
  type CheckSpec,
  type VerificationBackend,
  type VerificationContext,
} from "./verification";

export {
  buildTaskGraph,
  GraphValidationError,
  validateCompleted,
  type GraphNode,
  type TaskGraph,
  type ValidatedTask,
} from "./task-graph";

export {
  DefaultModelRouter,
  defaultModelRouter,
  routeForSpecialist,
  type CostTier,
  type ModelDescriptor,
  type ModelRouter,
  type ModelRoutingContext,
} from "./model-router";

export {
  DEFAULT_TOOL_ROUTING,
  createToolPolicyEngine,
  defaultToolPolicyEngine,
  type ApprovalDecision,
  type ToolPolicyDecision,
  type ToolPolicyEngine,
  type ToolRouting,
} from "./tool-policy";

export {
  DEFAULT_SPECIALISTS,
  SPECIALIST_TO_SUBAGENT,
  createSpecialistRegistry,
  defaultSpecialistRegistry,
  type Capability,
  type SpecialistRisk,
  type SpecialistRole,
  type SpecialistRegistry,
  type SpecialistSelection,
  type SpecialistSpec,
} from "./specialists";

export { taskCapabilities } from "./planner";

export {
  DefaultPlanner,
  type PlanningBackend,
  type PlanningContext,
  type PlanningResult,
} from "./planner";

export {
  DEFAULT_CONTEXT_OPTIONS,
  buildTaskContext,
  type BuiltContext,
  type ContextBuilderOptions,
  type EvidenceSource,
} from "./context";

export {
  noopMemory,
  NoopMemory,
  type MemoryContract,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryScope,
  type JobFact,
  type ProjectFact,
  type StrategyRecord,
} from "./memory";

export {
  VaulltcoreJobEngine,
  createVaulltcoreJobEngine,
  EngineSpecialistRunner,
  type SpecialistRunner,
  type SpecialistRunInput,
  type SpecialistRunOutput,
  type JobEngine,
  type JobEngineOptions,
  type JobEngineResult,
  type JobEngineRunOptions,
} from "./orchestrator";

export {
  JobAggregate,
  canTransition,
  canTaskTransition,
  type ArtifactRecord,
  type ConstraintSet,
  type EvidenceItem,
  type JobOutcome,
  type JobPlanSnapshot,
  type JobPlanSummary,
  type JobSnapshot,
  type JobStatus,
  type RepositoryContext,
  type TaskOutcome,
  type TaskSpec,
  type TaskStatus,
  type VerificationResult,
} from "./job-model";
