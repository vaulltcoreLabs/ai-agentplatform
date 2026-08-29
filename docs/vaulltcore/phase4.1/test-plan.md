# Phase 4.1 — Test Plan

## Test layers

| Layer | Where | Tooling |
| --- | --- | --- |
| Unit (existing) | `packages/workflow/*.test.ts` (pre-existing) | bun:test |
| Distributed acceptance | `packages/workflow/distributed.test.ts` | bun:test, shared `MemorySharedBackend` |
| Multi-runtime race (planned) | `packages/workflow/distributed-race.test.ts` | bun:test |
| Chaos (extended) | `packages/workflow/distributed.test.ts` (F-9) | bun:test, `TestClock.advance` + crash executor |

## How multi-process is modeled in tests

`makeBackend()` returns a single `MemorySharedBackend`. `build(backend, ...)`
returns a `DistributedDurableRuntime` whose inner `DurableWorker` is wired to
that backend. Two calls to `build(backend)` with the same backend produce two
runtimes that share state exactly as two OS processes would (per-key atomic
CAS serializes all access). `TestClock` is the shared `Clock`, advanced
explicitly to simulate lease/visibility-timeout expiry.

## Acceptance tests (current)

- **F-2** `real idempotency`: 3 concurrent `submit` with same `idempotencyKey`
  → exactly one job/run created.
- **F-1** `real CAS / fencing`: two runtimes race to claim the same step; stale
  commit rejected (`lease_lost`).
- **F-3** `cross-process durable cancellation`: `r1.cancel()` on a different
  runtime than the executor; the executor observes the marker on next poll and
  stops.
- **F-4** `durable checkpoint recovery`: complete a step, then construct a
  fresh store from the same backend and assert the checkpoint is visible.
- **F-5** `budget exhaustion`: usage over a tiny budget → run transitions to
  `failed` with `failureClass: "budget"`.
- **F-7** `multi-step DAG`: A→B,C→D,E executes in topological order; D and E
  only run after their parents complete.
- **F-9** `chaos: worker crash + resume`: crash mid-execute (lease left intact),
  advance clock past lease TTL, a second runtime resumes and completes the run.
- **F-10** `authorization`: a run submitted under `TENANT_A` cannot be
  `getJob` by `TENANT_B` (throws `UnauthorizedError`).
- **F-12/F-15** `tenant isolation`: per-tenant `MemorySharedBackend`-keyed data
  does not leak across tenant ids; cross-tenant lease claim fails.

## Race / distributed tests (implemented)

These run against TWO independent runtime/store instances sharing one
`MemorySharedBackend` — the definition of a distributed test, not two objects
over one in-memory Map.

- **TEST 2/15** `stale worker commit rejected`: Worker A holds lease v1 and
  pauses; lease expires; Worker B reclaims (version advances); A's
  `completeStep` with the stale lease/version returns `lease_lost` /
  `version_conflict`. No stale worker may overwrite newer state.
- **TEST 12** `duplicate queue message`: re-enqueuing the initial work command
  (same `runId` messageId) is a no-op (`enqueue` returns `false`); the 5-task
  DAG executes exactly 5 steps — a re-delivered message cannot duplicate a
  durable completion.
- **TEST 13** `lost queue message recovered`: every queue message is
  dead-lettered; the run is stranded `running`; `reconcile()` rediscovers the
  active run and re-enqueues; a worker then drives it to `completed`.
- **TEST 9** `budget across workers`: two separate worker instances each report
  usage to the SHARED durable usage store; combined usage trips budget
  exhaustion — enforcement is durable, not local.
- **TEST 14** `expired lease reclaimed`: a crashed worker leaves its lease
  intact; after TTL the lease appears in `getExpiredLeases`; a fresh worker
  reclaims and completes the run.
- **TEST 20** `event sequence under concurrency`: 40 concurrent
  `EventStore.append` calls to one run produce 40 strictly-monotonic, unique
  sequences.

## Remaining planned (CONTRACTUAL, not yet exercised)

- Network-partition chaos: block `backend.cas` for one runtime while another
  proceeds (requires a fault-injecting `SharedBackend` adapter — contract
  supports it; no test yet).
- Crash-after-commit / message-redelivery-to-terminal-run: covered by the
  consistency model's reasoning; an explicit chaos test is FUTURE.

## Chaos engine (F-9/F-11)

`TestClock` + `crashAfterExecute` executor simulate a hard worker death.
Planned extensions:
- crash before ack (current)
- crash before commit
- crash after commit (step durable, message must redeliver)
- network partition: block `backend.cas` for one runtime while another proceeds
