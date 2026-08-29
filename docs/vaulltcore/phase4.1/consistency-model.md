# Phase 4.1 — Consistency Model

## Guarantees

### Per-key linearizability (F-1)
EVERY mutator on `MemorySharedBackend` (`cas`, `append`, `incr`, `del`) is
serialized through a per-key promise chain on `locks[key]`; reads (`get`,
`list`) await that chain so they observe linearizable values. Within one
`backend` instance, all ops on a given key are strictly ordered. This gives:

- **Lease fencing**: `DistributedTaskLeaseStore.claim` does
  `get → cas(expected, next)`; a stale worker reading an old lease will fail the
  CAS (because a newer lease overwrote the key) and `claim` retries. The
  `completeStep`/`failStep` version check on `Step.version` is a second fence:
  a stale commit with an old `lease.version`/`step.version` is rejected with
  `lease_lost` / `version_conflict`. TEST 2/15 proves this directly.
- **Idempotency dedup**: `DistributedIdempotencyStore` CAS on
  `(resource, idempotencyKey)` ensures exactly one producer wins a race (F-2).
- **Strictly monotonic event sequences**: `DistributedEventStore.append`
  allocates `sequence` via the now-atomic `incr` and appends via the now-atomic
  `append`. Two workers appending to the same run concurrently receive
  distinct, strictly increasing sequences. TEST 20 proves this under 40-way
  concurrent append. (A real adapter satisfies the same contract with a single
  `UPDATE … RETURNING` / DO transaction / Lua script — never two round-trips.)

### State machine invariants
- A `Step` only transitions forward within its allowed graph
  (`queued → running → completed|failed|rejected|cancel_requested`).
- `saveStep(next, expectedVersion)` rejects version mismatches, so concurrent
  transitions are lost-update-safe.
- `transitionRun` requires `expectedVersion`; a stale run update fails
  `.catch(() => undefined)`.

### At-least-once delivery (F-9/F-11)
`DistributedQueue`:
- `enqueue` appends `messageId` to `qvisible` with `availableAt = now`.
- `claim` sets `availableAt = now + visibilityTimeoutMs` so the message is
  invisible to others; the message **remains in `qvisible`** (no removal).
- `ack` removes from `qvisible` and deletes the meta + inflight entries.
- **Crash recovery**: a worker that dies **without** acking leaves the message
  in `qvisible` with an `availableAt` in the past once the visibility timeout
  elapses → the next `claim` redelivers it (at-least-once).
- `retry(messageId, delayMs)` only mutates meta (`availableAt`, `attempt`,
  `receivedCount`); no second `qvisible` entry is created (dedup-safe).

### Re-enqueue-after-ack (run progression)
On step completion, `processOne` acks the consumed message **first**, then
re-enqueues a run-progress message. Doing ack-then-enqueue (not enqueue-then-
ack) sidesteps the risk that the queue's per-`messageId` dedup rejects the
re-enqueue while the prior meta is still being cleared.

### Reconciliation — lost-message recovery (TEST 13)
The queue is transport, not truth. A run can become stranded in a non-terminal
state if the producing worker died *after* acknowledging the prior message but
*before* re-enqueuing the next, or if the queue lost/dropped a message.
`DistributedDurableRuntime.reconcile()` is the deterministic recovery loop:

1. `WorkflowStore.listActiveRunIds()` enumerates every run still in
   `queued`/`running`/`verifying`/`cancel_requested` (provider-neutral: a real
   adapter scans the runs table with a status filter — never a global lock).
2. For each active run, `reconcile()` re-injects exactly one work command whose
   `messageId` is the `runId`. The enqueue is idempotent: the queue dedups on
   `(messageId)`, so a redundant reconcile is a no-op when an in-flight work
   command already exists — it never floods the queue.
3. A subsequent worker poll claims the message, calls `releaseSteps`, and either
   continues the DAG or observes the run is already terminal (acks + drops).

This makes the system correct under at-least-once delivery: a missing message
is always rediscoverable because the durable store — not the queue — is the
source of truth. `reconcileAndDrive()` runs reconcile then drains the worker
for self-healing worker processes.

## What is NOT guaranteed

- **Global serializability across runs**: independent runs are independent
  state machines; no cross-run transaction. Concurrency is coordinated only via
  shared-key CAS within a run.
- **Exactly-once side effects**: the execution plane (`StepExecutor`) is invoked
  at-most-once per *lease*, but after a crash the step may be re-executed under
  a new lease. The executor receives `idempotencyKey` and is responsible for
  making side effects idempotent (the layer guarantees re-delivery, not
  de-duplication of external I/O).
- **No cross-tenant leakage**: enforced by `AuthorizationStore`/
  `resolveJobTenant` at the runtime boundary; within the durable layer, tenant
  ids namespace all keys (`tenantKey(tenantId, ...)`).

## Failure model

| Failure | Detection | Recovery |
| --- | --- | --- |
| Worker crash mid-execute | Lease expiry (clock) + unhandled exception | `releaseSteps` resets orphaned step; queue redelivers message. |
| Worker crash mid-commit | Second fence in `completeStep`/`failStep` rejects stale commit | Step re-leases; deterministic re-execute. |
| Worker crash after commit, before ack | Message visibility timeout expires | Run stays `completed` (step durable); message redelivered → `releaseSteps` sees task already terminal → `run` is terminal → message acked & dropped. |
| Run stuck in `verifying` | No special handling; any worker re-runs `maybeFinalize` | Idempotent two-phase transition completes. |
| Lease clock skew | Leases are monotonic in `now()`; expiry is relative to claim time | Bounded by `leaseConfig` TTL + heartbeat margin. |

## Capacity / scaling model

- One `SharedBackend` instance = one failure domain (per CF Durable Object
  namespace shard). Multiple backends partition by tenant/run.
- `releaseSteps` returns **one** step per poll by design; throughput =
  `workers × (1 poll / poll-latency)`. Poll latency is gated by queue claim
  (no busy-wait when idle: `stopWhenIdle` exits the loop).
- Leases are the unit of single-flight per step (not per run); a run with N
  independent tasks fans out across N polls/workers.
