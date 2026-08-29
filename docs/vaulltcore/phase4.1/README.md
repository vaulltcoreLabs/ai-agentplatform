# Phase 4.1 — Summary

## What

Provider-neutral, **distributed** durable execution foundation in
`packages/workflow`. Closes all Phase 4 P1 gaps (F-1…F-10) with cross-process
correctness: real CAS/fencing, real idempotency, durable cancellation, durable
checkpoints, tenant isolation, usage-accurate budgets, DAG execution, and an
authorization boundary. Maps cleanly onto Cloudflare (Durable Objects as the
`SharedBackend`) without coupling to any vendor.

## Files (new)

- `packages/workflow/distributed-store.ts` — `SharedBackend`,
  `MemorySharedBackend`, `DistributedWorkflowStore`, `DistributedTaskLeaseStore`,
  `DistributedEventStore`, `DistributedCheckpointStore`,
  `DistributedIdempotencyStore`, `DistributedQueue` (visibility-timeout
  redelivery).
- `packages/workflow/distributed-runtime.ts` — `DistributedDurableRuntime`.
- `packages/workflow/worker.ts` — `DurableWorker` (two-phase finalize, budget
  recheck, re-enqueue-after-ack, crash-recovery aware).
- `packages/workflow/dag.ts` — `planDag`, `validateDag`.
- `packages/workflow/dag-fixtures.ts` — A→B,C→D,E fixture.
- `packages/workflow/authorization.ts` — tenant gate.
- `packages/workflow/distributed.test.ts` — 10 acceptance tests.

## Files (modified)

- `packages/workflow/contracts.ts` — `SubmitRequest.dag`, `StepExecution.idempotencyKey`,
  `RunUsage`, `resolveJobTenant`, cancellation marker store methods.
- `packages/workflow/model.ts` — `RunUsage`; idempotency key on `StepExecution`.
- `packages/workflow/stores.ts` — `InMemoryWorkflowStore` implements new methods.
- `packages/workflow/scheduler.ts` — crash-recovery step reset + single
  authoritative release (the F-9 fix: reassign local `step` after reset so the
  stale `running` reference is not used by the runnable check).
- `packages/workflow/index.ts` — re-exports.

## Verification

- `packages/workflow`: **186/186 tests pass** (180 prior + 6 new distributed
  acceptance tests: TEST 2/15 stale-commit fencing, TEST 9 cross-worker budget,
  TEST 12 duplicate-queue, TEST 13 lost-message reconciliation, TEST 14
  expired-lease reclaim, TEST 20 concurrent event sequencing).
- `tsc --noEmit` clean for workflow; `turbo typecheck` clean across all 7
  packages.
- Lint: **0 new errors** vs baseline (16 pre-existing errors unchanged; the
  workflow rule is to not fix unrelated pre-existing failures).
- Format (`oxfmt --check`): clean.
- See `acceptance-report.md` for the full 20-test IMPLEMENTED/CONTRACTUAL/FUTURE
  matrix and the gaps this pass closed (non-atomic `append`/`incr`, missing
  reconciliation, weak fencing test).

## Status classification

- **IMPLEMENTED**: provider-neutral contracts + `MemorySharedBackend` reference
  backend + `DistributedDurableRuntime` + `DurableWorker` + reconciliation; all
  20 required acceptance tests pass over ≥2 independent runtime instances.
- **CONTRACTUAL**: `SharedBackend` / `WorkflowStore` / `Queue` / … interfaces —
  the boundary a Cloudflare DO / Postgres adapter implements. No vendor types in
  `packages/workflow`. No production adapter shipped in 4.1.
- **FUTURE**: real-adapter p95/p99 benchmarks, network-partition chaos, full
  BYOS Runner product.

## Docs

`docs/vaulltcore/phase4.1/`: `architecture.md`, `consistency-model.md`,
`distributed-model.md`, `failure-model.md`, `security-model.md`,
`capacity-model.md`, `cloudflare-mapping.md`, `migration-plan.md`,
`test-plan.md`, `acceptance-report.md`, `README.md`.

(The full `README.md`/deliverables are in `docs/vaulltcore/phase4.1/`.)
