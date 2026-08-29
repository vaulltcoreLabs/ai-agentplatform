# Phase 3: Intelligence Layer

## Overview

The Intelligence layer (`packages/intelligence/`) sits between the Phase 1 Agent Engine and the Phase 2 Sandbox. It is **provider-neutral by construction**: it never imports a concrete model provider, sandbox implementation, or cloud platform. Its only hard dependency is `@vaulltcore/agent` (error taxonomy, event types, model-selection contract) and `@vaulltcore/sandbox` (state typing via duck-typed records).

## Architecture

```
┌──────────────────────────┐
│  Phase 4 Control Plane    │  (future)
└────────────┬─────────────┘
             │  provider-neutral contracts
┌────────────▼─────────────┐
│  packages/intelligence   │
│                          │
│  ┌────────────────────┐ │
│  │  Orchestrator       │ │
│  │  (lifecycle)        │ │
│  └────────┬───────────┘ │
│           │             │
│  ┌────────▼──┐┌───────┐ │
│  │ Planner   │ │ Router│ │
│  └────────┬──┘└───────┘ │
│           │             │
│  ┌────────▼──────────┐ │
│  │ Task Graph (DAG)  │ │
│  └────────┬──────────┘ │
│           │             │
│  ┌────────▼──────────┐ │
│  │ Scheduler         │ │
│  └────────┬──────────┘ │
│           │             │
│  ┌────────▼──────────┐┌──────────────┐
│  │ Specialists       │ │ Tool Policy  │
│  └────────┬──────────┘ └──────┬─────┘
│           │                   │
│  ┌────────▼───────────────────▼─────┐
│  │  Phase 1: Agent Engine            │
│  └──────────────────────────┬────────┘
│                             │
│  ┌──────────────────────────▼────────┐
│  │  Phase 2: Sandbox                 │
│  └───────────────────────────────────┘
└──────────────────────────────────────┘
```

## Design Principles

### 1. Provider Neutrality
- No imports of `openai`, `anthropic`, `@ai-sdk/*`, `vercel`, `docker`, `@neondatabase`, etc.
- All provider communication flows through Phase 1 interfaces: `VaulltcoreAgent`, `ModelResolver`, `PermissionResolver`, `VaulltcoreTool`.
- The `ModelRouter` returns `ModelSelection` objects — never a provider-specific config.

### 2. Event Sourcing
- `MemoryEventLog` stores immutable, frozen `IntelligenceEvent` records with monotonically increasing sequences.
- Every state change appends events: `job.created`, `job.planned`, `task.started/completed`, `verification.*`, `repair.*`, `job.completed/failed/cancelled`.
- `JobAggregate` is a projection reconstructable from events via `JobAggregate.reconstruct`.

### 3. Bounded Work
- **Concurrency**: `Scheduler` enforces `maxParallelism` from `ExecutionPolicy`.
- **Budgets**: `BudgetTracker` tracks model calls, tool calls, tokens, cost, runtime, and active agents. Breaches raise `BudgetFailure`.
- **Timeouts**: Per-task `withTimeout` and job-level `maxRuntimeMs` deadline.

### 4. Deterministic Idempotency
- Job IDs derived from `tenantId + objective` (`createJobId`).
- Task IDs derived from `jobId + specialist + input` (`createTaskId`).
- Safe to resubmit: returns the same job ID, can resume.

## Module Map

| Module | Responsibility | Key Exports |
|--------|---------------|-------------|
| `ids.ts` | Deterministic ID generation | `createJobId`, `createTaskId`, `deterministicId` |
| `correlation.ts` | Trace correlation bundles | `CorrelationId`, `newCorrelation`, `withTask` |
| `policy.ts` | Execution policy + override | `ExecutionPolicy`, `DEFAULT_EXECUTION_POLICY` |
| `budget.ts` | Resource budget tracking | `BudgetTracker`, `Budget`, `BudgetBreach` |
| `errors.ts` | Intelligence failure taxonomy | `IntelligenceError`, `FailureClass`, `classifyError` |
| `events.ts` | Event types + in-memory log | `IntelligenceEvent`, `MemoryEventLog` |
| `job-model.ts` | Job aggregate + state machines | `JobAggregate`, `JobSnapshot`, transitions |
| `task-graph.ts` | DAG building + validation | `buildTaskGraph`, `TaskGraph`, cycle detection |
| `specialists.ts` | Specialist roles + registry | `SpecialistSpec`, `SpecialistRegistry`, `DEFAULT_SPECIALISTS` |
| `planner.ts` | Objective → task decomposition | `DefaultPlanner`, `PlanningContext`, `PlanningResult` |
| `context.ts` | Task-scoped context assembly | `buildTaskContext`, `BuiltContext` |
| `tool-policy.ts` | Tool permission engine | `ToolPolicyEngine`, `DEFAULT_TOOL_ROUTING` |
| `verification.ts` | Verification + evidence | `DefaultVerifier`, `VerificationResult` |
| `model-router.ts` | Model selection | `ModelRouter`, `ModelDescriptor` |
| `scheduler.ts` | Bounded-parallel execution | `scheduleExecution`, `SchedulerCallbacks` |
| `orchestrator.ts` | Job lifecycle coordinator | `VaulltcoreJobEngine` |

## Execution Flow

1. **Request**: `engine.run({ objective, ... })`
2. **Plan**: `DefaultPlanner.plan()` decomposes the objective into a `TaskGraph` (topologically sorted DAG).
3. **Schedule**: `scheduleExecution()` executes ready tasks under concurrency limits.
4. **Execute**: Each task routes to its specialist via `SPECIALIST_TO_SUBAGENT` mapping.
5. **Verify**: `DefaultVerifier.verify()` runs checks; collects evidence, computes confidence.
6. **Repair**: If verification fails, `repair()` selects a repair specialist and re-attempts (bounded by `RetryPolicy.maxRepairAttempts`).
7. **Complete**: `completed` or `failed`.

## Failure Taxonomy

| `FailureClass` | Recoverable | Meaning |
|----------------|-------------|---------|
| `model` | Yes | Model call failed |
| `tool` | Yes | Tool invocation failed |
| `sandbox` | Yes | Sandbox interaction failed |
| `verification` | Yes | Verification checks failed |
| `permission` | No | Permission denied |
| `configuration` | No | System/config error |
| `planning` | No | Invalid plan or cyclic graph |
| `budget` | No | Resource ceiling exceeded |
| `context` | No | Missing required context |
| `dependency` | Yes | Prerequisite task failed |
| `unknown` | Yes | Unclassified — transient |
| `cancellation` | No | Operator aborted |

## Testing

```bash
bun test packages/intelligence/
```

105 tests covering: IDs, policies, budgets, errors, task graph DAG, specialists, planner, context, tool-policy, verification, model-router, scheduler, and end-to-end orchestrator runs.
