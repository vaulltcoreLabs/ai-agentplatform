# Phase 4.1 — Migration Plan (incremental, non-breaking)

## Phase 1 — contracts
- `SubmitRequest` carries an optional `dag` (`DagSpec`: `name -> dependsOn`).
- `StepExecution` carries `idempotencyKey`.
- Added `RunUsage`, `DurableEvent` re-export, `resolveJobTenant`, and
  `CancellationMarkerStore` methods on `WorkflowStore`.
- `InMemoryWorkflowStore` (`stores.ts`) implements the new methods
  (no-op marker, zero usage) so legacy callers compile unchanged.

## Phase 2 — distributed foundation
- `distributed-store.ts`: `SharedBackend` + `MemorySharedBackend` +
  `DistributedWorkflowStore`, `DistributedTaskLeaseStore`,
  `DistributedEventStore`, `DistributedCheckpointStore`,
  `DistributedIdempotencyStore`, `DistributedQueue`.
- `distributed-runtime.ts`: `DistributedDurableRuntime`.
- `worker.ts`: `DurableWorker` — two-phase finalize, post-step budget recheck,
  re-enqueue-after-ack.
- `scheduler.ts`: crash-recovery step reset + single authoritative release.
- `dag.ts` + `dag-fixtures.ts`: planner + validator + fixture.
- `authorization.ts`: `resolveJobTenant`-based tenant gate.

## Phase 3 — acceptance
`packages/workflow/distributed.test.ts` exercises F-1, F-2, F-3, F-4, F-5,
F-7, F-9, F-10, F-12/F-15 via `DistributedDurableRuntime` with shared
`MemorySharedBackend`.

## Phase 4 — Cloudflare swap (planned)
Production replaces `MemorySharedBackend` with a Durable-Object-backed
`SharedBackend`. No change to contracts/scheduler/worker/runtime.

## Rollback
Stop wiring `DistributedDurableRuntime`; keep `DurableWorkflowRuntime`.
Additive-only schema fields.
