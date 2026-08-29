# Phase 4.5 — Forensic Acceptance Report

**Date:** 2026-08-24
**Scope:** Infrastructure separation made real: production durable backend,
queue semantics on a durable substrate, runner protocol contracts. No Phase 5,
no product/UI work, no rewrites of Phases 1–4.4.

## A. Inspected

Full package graph (`agent`, `intelligence`, `workflow`, `sandbox`, `shared`,
new `adapters`); the `SharedBackend` primitive contract (atomic
`cas`/`append`/`incr` with documented per-key atomicity requirements);
`Distributed*` store implementations (workflow/lease/event/checkpoint/
idempotency/queue); `DurableWorker` lifecycle; `SandboxStepExecutor` supplier
pattern; sandbox provider registry (vercel/docker); Phase 1–4.4 docs;
boundary test from Phase 4.4.

## B. Changed (complete list)

| File | Change |
| --- | --- |
| `packages/adapters/**` | NEW Layer-2 package: `SqliteSharedBackend` (WAL + `BEGIN IMMEDIATE`; atomic CAS/append/incr/del across independent connections), `openDurableSqlite` composition root, 8 distributed acceptance tests |
| `packages/workflow/runner-protocol.ts` | NEW provider-neutral runner protocol: `ExecutionEnvelope`, `RunnerRegistry` (revocable hashed credentials), `RunnerSession` handshake state machine, `RunnerControlPlane` (tenant gating + stale-result fencing) |
| `packages/workflow/runner-protocol.test.ts` | NEW 14 protocol tests |
| `packages/workflow/index.ts` | Re-export runner protocol symbols |
| `docs/vaulltcore/infrastructure/README.md` | §11 added: Phase 4.5 deliverables, measured memory table, test results |

## C. Intentionally NOT changed

Agent Engine, Intelligence, Workflow contracts/model/stores/runtime, Sandbox
interface/providers/security policy, apps/web, apps/api, existing Phase 4.1
distributed stores and tests, deployment scripts, auth config. The known
`claim()` CAS-result-tolerance in `DistributedQueue` (double-claim window) is
documented as at-least-once behavior absorbed by downstream idempotency — not
altered.

## D/E. Architecture before → after

Before: contracts + in-memory reference backend only; runner protocol existed
only as prose design. After: one REAL shared backend (SQLite/D1-semantics)
proving the contract's atomicity guarantees on an actual database engine; the
runner boundary expressed as enforceable code; adapters layer established as
its own package so core stays SDK-free.

## F–J. Boundary / state / queue / runner / sandbox models

Unchanged from `README.md` §2–§5 — this phase implemented against them, did
not redesign them.

## K. Security model

Preserved untouched (deny-by-default network, path/command/file-size policies,
redaction). New protocol adds tenant-scope enforcement and fencing-token
validation at assignment/result time; credentials are per-runner, revocable,
stored hashed. Runner compromise does not reach the control plane: runners are
handed envelopes only after scope validation and can commit only above their
assigned fencing token.

## L. Failure/recovery coverage demonstrated by tests

Duplicate submit race (F-2), cross-runtime cancellation marker visibility
(F-3), queue redelivery after visibility timeout, delayed retry, message-id
dedup, CAS contention loser rejection, lease-fencing stale-commit rejection at
backend level. Remaining failure-injection cases ride the existing Phase 4.1
chaos suite (`chaos.test.ts`, `runtime.chaos.test.ts`) which continues to pass.

## M/N/O. Memory, CPU, performance

Memory measured live (see README §11): warm Vite ≈ 785 MB explains the
historical "788 MB" figure; API ~56–163 MB; wrappers ~230 MB dev-only.
Production targets: control plane 250–400 MB, runner ~120 MB, sandboxes
per-container. CPU/p50/p95/p99 benchmarks NOT yet built — marked FUTURE;
no optimization performed without them (per prohibitions).

## P. Cost model

Carried from README §7 with plane-split correction. Per-execution cost still
requires workload telemetry (FUTURE).

## Q. Test results

adapters 8/8 · workflow 232/232 · sandbox 92/92 · intelligence 108/108 ·
agent 46/48 (2 pre-existing upstream `ai@6.0.194` export drift failures;
untouched by this phase) · typecheck clean for workflow, sandbox, adapters.
Lint/boundary suite green via `bun test packages/workflow/boundary.test.ts`
(covered inside the 232).

## R. Known limitations

1. SQLite backend is single-writer (serialized) — correct for current scale;
   Postgres/DO adapters will parallelize writes later using identical SQL/CAS
   semantics.
2. WebSocket transport for the runner protocol not implemented (FUTURE).
3. Runner credential store is process-local; durable credential persistence
   is FUTURE.
4. Two agent tests fail on upstream SDK drift — needs an `ai` pin bump or
   import migration in a dedicated fix (out of scope here).
5. Performance benchmarks (p50/p95/p99) not yet instrumented.

## S. IMPLEMENTED / CONTRACTUAL / FUTURE matrix (Phase 4.5 deltas)

| Item | Status |
| --- | --- |
| Real SharedBackend with atomic CAS/append/incr | IMPLEMENTED |
| Queue dedup / visibility timeout / retry on durable substrate | IMPLEMENTED |
| Duplicate submission safety across two runtimes + real DB | IMPLEMENTED |
| Cross-runtime durable cancellation visibility | IMPLEMENTED |
| Stale-commit fencing at backend level | IMPLEMENTED |
| Runner envelope/identity/handshake/fencing contracts | IMPLEMENTED |
| Runner transport (WebSocket), durable credential store | FUTURE |
| Postgres/Durable Objects backend adapter | CONTRACTUAL → next |
| Warm pools, BYOS, p95 benchmarks | FUTURE |

## T. Recommended next phase (4.6)

1. Fix the two pre-existing agent test imports (upstream `ai` drift).
2. Postgres `SharedBackend` adapter reusing the same acceptance test file with
   a connection-string parameter (tests skip without `POSTGRES_URL`).
3. WebSocket transport adapter + deployable `vaulltcore/runner` service image.
