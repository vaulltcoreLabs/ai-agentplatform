# Phase 4.1 — Failure Model

## Failure modes & handling

| # | Failure | Detected by | Recovery |
| --- | --- | --- | --- |
| 1 | Worker process dies mid-execute | Lease expiry (`expiresAt`) + unhandled throw | `releaseSteps` resets orphaned `running`/`waiting` step to `queued`; queue redelivers the message after visibility timeout. |
| 2 | Worker dies mid-commit | `completeStep`/`failStep` version/fence check fails | Next poll re-leases the step; executor re-runs with a fresh lease (idempotency key supplied). |
| 3 | Worker dies after commit, before ack | Run already `completed`/`failed`; message still in `qvisible` | Message redelivered → `processOne` sees run terminal → acks & drops message. |
| 4 | Stuck in `verifying` | Run state read on next poll | `maybeFinalize` is idempotent: any worker re-observes all tasks terminal and transitions to `completed`. |
| 5 | Lease renewal fails / clock skew | `renew` returns false / `expiresAt <= now` | Lease treated as lost; step reset to `queued` by crash recovery. |
| 6 | Budget exceeded by a single step | Post-step `guardBudget` recheck | `failRunBudget` transitions run → `failed` with `failureClass:"budget"`; deterministic. |
| 7 | DAG cycle | `validateDag` at submit | Submit rejected before any task created. |
| 8 | Duplicate submit (same idempotencyKey) | `DistributedIdempotencyStore` CAS | Exactly one job/run created; others return the existing one. |
| 9 | Cross-tenant access | `AuthorizationStore.resolveJobTenant` | `assertAuthorized` throws `UnauthorizedError`; no data read/written. |
| 10 | Visibility-timeout too short (thundering redeliver) | Configurable `visibilityTimeoutMs` (default 30s) | Tuned per workload; at-least-once is the contract, not exactly-once. |

## Liveness

- As long as at least one worker polls and the backend is available, a run
  with at least one un-terminated step makes progress (steps become `queued`,
  get leased, executed).
- A run is `completed` iff all its tasks are terminal and none failed.

## Safety

- A step is executed by **at most one live lease holder** at a time (fencing).
- A completed step's state is never reverted to `queued`/`running`
  (`saveStep` uses expected-version CAS + forward-only state checks).
- A run never transitions from a terminal state.
