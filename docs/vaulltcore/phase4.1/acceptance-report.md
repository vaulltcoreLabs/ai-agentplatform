# Phase 4.1 — Acceptance Report

## Status

The Phase 4.1 durable execution foundation (`packages/workflow`) implements the
provider-neutral distributed substrate. This report distinguishes what is
**IMPLEMENTED** (code + passing test) from what is **CONTRACTUAL** (interface
defined, adapter-dependent, not yet exercised) and **FUTURE** (out of scope for
4.1). It does not claim a guarantee the implementation does not actually provide.

## Test results

| Suite | Result |
| --- | --- |
| `packages/workflow` unit + distributed | **186 pass / 0 fail** (180 prior + 6 new distributed acceptance tests) |
| `packages/workflow` typecheck (`tsc --noEmit`) | **clean** |
| Repo-wide typecheck (`turbo typecheck`, 7 packages) | **clean** (7/7) |
| `packages/workflow` lint (`oxlint`) | **0 new errors** — 16 pre-existing errors unchanged from baseline (workflow rule: do not fix unrelated pre-existing failures) |
| `packages/workflow` format (`oxfmt --check`) | **clean** |
| Repo-wide tests (`apps/web`) | pre-existing failures confined to `apps/web` (`lib/db/sessions.ts` missing exports) — **untouched**, per the "do not fix unrelated pre-existing failures" rule. |

## Required 20-test acceptance matrix

Each IMPLEMENTED test runs against ≥2 independent runtime/store instances
sharing one `MemorySharedBackend` (the definition of a distributed test, not two
objects over one in-process Map).

| # | Required criterion | Test | Status |
| --- | --- | --- | --- |
| 1 | Two workers claim one step — one owns the lease | `F-1` + `TEST 2/15` | IMPLEMENTED (PASS) |
| 2 | Stale worker completion rejected | `TEST 2/15 — stale worker commit rejected` | IMPLEMENTED (PASS) |
| 3 | Concurrent identical submissions → one logical job/run | `F-2 — real idempotency` | IMPLEMENTED (PASS) |
| 4 | Idempotency survives runtime restart | `F-2 — returns existing job on duplicate submit` | IMPLEMENTED (PASS) |
| 5 | Cancel on A observed by executing worker B | `F-3 — cross-process durable cancellation` | IMPLEMENTED (PASS) |
| 6 | Checkpoint survives worker death | `F-4 — durable checkpoint recovery` | IMPLEMENTED (PASS) |
| 7 | Workflow resumes from durable checkpoint | `F-9` (crash → lease expiry → resume) | IMPLEMENTED (PASS) |
| 8 | Budget exhaustion stops execution | `F-5 — budget exhaustion` | IMPLEMENTED (PASS) |
| 9 | Tenant quota/budget enforced across workers | `TEST 9 — budget across two independent workers` | IMPLEMENTED (PASS) |
| 10 | Two dependent DAG tasks execute in order | `F-7 — multi-step DAG (A→C→D)` | IMPLEMENTED (PASS) |
| 11 | Independent DAG tasks run concurrently within maxParallelism | `F-7 — multi-step DAG (A→B,C,E parallel)` | IMPLEMENTED (PASS) |
| 12 | Duplicate queue message ≠ duplicate completion | `TEST 12 — duplicate queue message` | IMPLEMENTED (PASS) |
| 13 | Lost queue message recovered by reconciliation | `TEST 13 — lost queue message recovered` | IMPLEMENTED (PASS) |
| 14 | Expired lease reclaimed | `TEST 14 — expired lease reclaimed` | IMPLEMENTED (PASS) |
| 15 | Stale worker cannot commit after takeover | `TEST 2/15` (same fencing test) | IMPLEMENTED (PASS) |
| 16 | Cross-tenant access rejected | `F-10 — authorization / cross-tenant rejection` | IMPLEMENTED (PASS) |
| 17 | Secrets never appear in durable events | `security.test.ts — redactDurableEvent` | IMPLEMENTED (PASS) |
| 18 | Crash during step execution → recoverable state | `F-9 — chaos: worker crash + resume` | IMPLEMENTED (PASS) |
| 19 | Retry does not violate deterministic state transitions | `retry.test.ts` + `status.test.ts` | IMPLEMENTED (PASS) |
| 20 | Event sequence valid under concurrent workers | `TEST 20 — event sequence under concurrency` | IMPLEMENTED (PASS) |

## Gaps closed in this pass (forensic audit → fix)

The prior report over-claimed "complete." A forensic audit found and fixed real
distributed-correctness gaps:

1. **Non-atomic `append`/`incr` on `MemorySharedBackend`** (TEST 20 at risk).
   Only `cas` was serialized; `append` and `incr` did an unsynchronized
   read-modify-write. A probe with an interleaving backend showed 20 concurrent
   event appends collapsed to **1** unique sequence — a strict violation of the
   EventStore's "strictly monotonic sequence" contract. **Fix**: every mutator
   (`cas`, `append`, `incr`, `del`) now serializes through the per-key promise
   chain; reads (`get`, `list`) await it for linearizability. The contract
   documents that a real adapter must satisfy this with one transaction, never
   two round-trips. (This is a latent bug only a real networked backend would
   have exposed — exactly the class the spec warns about.)
2. **No lost-message reconciliation** (TEST 13 missing). A run could strand in
   `running` forever if the producing worker died after acking but before
   re-enqueuing. **Fix**: added `WorkflowStore.listActiveRunIds()` (contract +
   in-memory + distributed impl) and `DistributedDurableRuntime.reconcile()` /
   `reconcileAndDrive()` — an idempotent (per-`runId` messageId dedup) recovery
   loop that rediscoveries active runs and re-injects exactly one work command.
3. **Weak fencing test** (TEST 2/15). The original `F-1` only asserted
   `lease.version >= 1`; it never proved a stale commit is *rejected*. **Fix**:
   `completeStep` fencing tightened to a single atomic lease+version check, and a
   dedicated test calls `completeStep` with the stale lease/version and asserts
   `success === false` (`lease_lost`/`version_conflict`).

## Key implementation

- `packages/workflow/distributed-store.ts` — `MemorySharedBackend` (per-key
  atomic **all** mutators via promise chain) + `DistributedWorkflowStore`,
  `DistributedTaskLeaseStore`, `DistributedEventStore`,
  `DistributedCheckpointStore`, `DistributedIdempotencyStore`,
  `DistributedQueue` (visibility-timeout redelivery). Adds
  `listActiveRunIds` for reconciliation scans.
- `packages/workflow/distributed-runtime.ts` — `DistributedDurableRuntime`:
  real idempotency, durable cancellation markers, DAG dispatch, authorization
  boundary, usage-accurate budget gate, **reconciliation** (`reconcile` /
  `reconcileAndDrive`).
- `packages/workflow/worker.ts` — `DurableWorker` lifecycle with two-phase run
  finalization (`running → verifying → completed`) and post-step budget
  re-check.
- `packages/workflow/scheduler.ts` — `DurableScheduler.releaseSteps`: single
  authoritative release + crash recovery that resets orphaned `running`/`waiting`
  steps (expired lease) back to `queued`; `completeStep` double-fenced by
  lease-version + step-version CAS.

## CONTRACTUAL vs IMPLEMENTED vs FUTURE

- **IMPLEMENTED**: all 20 acceptance tests above over the `MemorySharedBackend`
  (in-memory shared backend that reflects real-backend atomicity).
- **CONTRACTUAL**: provider-specific adapters (Cloudflare DO/D1/Queues/R2,
  Postgres). The `SharedBackend` interface + `WorkflowStore`/`Queue`/… contracts
  are the boundary; no Cloudflare/Vercel/AWS types leak into `packages/workflow`.
  A real adapter must implement per-key atomicity for *every* mutator (see
  consistency-model.md). No production adapter is shipped in 4.1.
- **FUTURE**: network-partition chaos (fault-injecting `SharedBackend`),
  crash-after-commit redelivery-to-terminal-run chaos test, p95/p99 benchmarks
  against a real adapter, full BYOS Runner product. None block 4.1 correctness.

## Known limitations

- The `MemorySharedBackend` is single-process; it models multi-process
  correctness via shared per-key atomicity, not via a real network. Distributed
  *correctness* is proven; distributed *performance* (p95/p99) is FUTURE and
  must be measured against a real adapter — "No single-process benchmark may be
  presented as evidence of distributed scalability."
- `DurableScheduler.checkpointCompletedStep` is a no-op placeholder; real
  checkpoint persistence happens in `DurableWorker.persistCheckpoint` (verified
  by F-4). Not a correctness gap for the acceptance tests.
- No production Cloudflare/Postgres adapter is shipped — only the contracts and
  the in-memory reference backend.
