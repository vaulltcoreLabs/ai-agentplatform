# Phase 4.1 — Distributed Model

This document describes the distributed execution model the acceptance tests
assert against, and how `MemorySharedBackend` models a multi-process system
in a single process.

## Shared backend = shared state

`MemorySharedBackend` is a single in-memory map keyed by tenant-namespaced
strings, with **per-key atomic CAS** (a promise chain per key serializes all
reads/writes/CAS on that key with respect to each other). Two
`DistributedDurableRuntime` instances constructed over the *same* backend
behave exactly like two OS processes sharing a database/Durable Object: every
CAS is observed by both, in order.

This is sufficient for the acceptance tests' cross-process semantics
(F-1 stale commit, F-2 concurrent submit, F-3 remote cancellation, F-9 crash
handoff).

## Clock

A shared `TestClock` is passed to every store and worker. `clock.advance(ms)`
simulates the wall clock moving forward, which expires leases and makes
visibility-timeout messages redeliverable. This models "time passing" in a
distributed system without sleeping.

## Leases

`DistributedTaskLeaseStore`:
- `claim(stepId, owner, ttl)`: `get → cas(expected, next)`. Fails (returns
  `null`) if a **valid** (non-expired, non-revoked) lease currently exists,
  guaranteeing single-flight per step.
- `completeStep`/`failStep` receive the claim's `lease.id` and `lease.version`;
  the scheduler re-validates ownership before committing. A stale worker (old
  version) is rejected with `lease_lost` → F-1.
- Lease expiry is `_key-level`: `expiresAt <= now && revokedAt === null`.

## Queue (at-least-once)

`DistributedQueue`:
- `enqueue` appends the `messageId` to the `qvisible` list with
  `availableAt = now` and stores meta under `qmeta::<id>`.
- `claim(worker, max, visTimeout)` iterates `qvisible`, skipping messages whose
  `availableAt > now`; for each redeliverable message it CAS-bumps
  `availableAt = now + visTimeout` (becoming invisible to others) and records an
  `qinflight::<worker>::<id>` entry.
- A message is **removed** only on `ack`; a crashed worker never acks, so the
  message redelivers after the visibility timeout → at-least-once (F-9/F-11).
- `retry(id, delay)` only mutates meta (`availableAt`, `attempt`,
  `receivedCount`); the message stays in `qvisible` exactly once → dedup-safe.

## Run finalization (two-phase)

`DurableWorker.maybeFinalize`:
1. If all tasks terminal and none failed → set run `running → verifying`.
2. Re-read; set `verifying → completed` (or `running → failed`).
3. Update job status.

Because the transition is keyed on the current state and version, the two
phases are idempotent — a crash after phase 1 is repaired by any worker that
re-observes terminal tasks.

## Re-enqueue-after-ack

On a successful step, `processOne`:
1. acks the consumed message (`ack` removes it from `qvisible`),
2. *then* re-enqueues a run-progress message.

Doing ack-then-enqueue (rather than enqueue-then-ack) avoids the queue's
per-message dedup rejecting the re-enqueue while the prior message meta is
still being cleared. Since `ack` and `enqueue` use **distinct ids** (run id vs.
message id), there is no false dedup; the ordering just keeps the queue
consistent if the worker crashes between the two steps.
