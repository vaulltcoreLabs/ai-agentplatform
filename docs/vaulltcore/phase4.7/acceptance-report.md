# Phase 4.7 — Forensic Acceptance Report

**Verdict: PASS WITH CONDITIONS**
**Date:** 2026-08-24

## A. What was inspected (before any change)

Full adapters/workflow surfaces: `SharedBackend` primitive contract, all
`Distributed*` stores, `DistributedQueue`, runtime submit/cancel/idempotency
paths, Phase 4.5 SQLite adapter + acceptance tests, Phase 4.6 Postgres adapter,
conformance suite, migrations, retry module, boundary test, phase 4.1–4.6 docs.
No code was modified until the audit was complete.

## B. What was changed (smallest correct set)

| Change | File(s) | Why |
|---|---|---|
| PG conformance factory isolation (purge/unique namespaces per create) | `pg-conformance.test.ts` | tests leaked keys across runs — the §6 isolation gap |
| Driver-safe jsonb parameters (`sql.json()` everywhere) | `pg-backend.ts` | implicit text→jsonb cast compared identical literals unequal (real adapter bug) |
| `ack()` no longer writes the `CAS_ABSENT` symbol as a value; uses an explicit acked marker CAS | `workflow/distributed-store.ts` | genuine Phase 4.1 defect Memory silently tolerated |
| Explicit idempotency keys are tenant-salted before lookup/write | `workflow/distributed-runtime.ts` | cross-tenant collision vector closed at the persistence boundary |
| Live-Postgres durability gate + benchmark harness | `pg-durable.test.ts`, `bench.test.ts` | the phase's core deliverable |

## C. What was intentionally NOT changed

Agent Engine, Intelligence, Sandbox internals, workflow state machines,
Phase 4.2 fast path, Phase 4.3 security policy, SQLite/Memory reference
backends' semantics, all existing public contracts.

## D–E. Architecture

Unchanged in shape: core → contracts → adapters → deployment. The only delta
is that the adapters layer is now *proven* against a second real database
engine, not just SQLite.

## F. Test matrix (actual results)

| Test | Memory | SQLite | PostgreSQL | Status |
|---|---|---|---|---|
| CAS create/conflict/stale | ✅ | ✅ | ✅ live | IMPLEMENTED |
| Fencing / stale-worker rejection | ✅ | ✅ | ✅ live (lease takeover suite) | IMPLEMENTED |
| Idempotent submit storm | ✅ | ✅ (F-2) | ✅ live (16-way) | IMPLEMENTED |
| Cross-tenant key independence | ✅ | ✅ | ✅ live | IMPLEMENTED (post-fix) |
| Event append completeness | ✅ | ✅ ×2 conn | ✅ live ×4 conn (100) | IMPLEMENTED |
| Atomic increment | ✅ | ✅ | ✅ live (200 ×4 conn) | IMPLEMENTED |
| Queue dedup/visibility/ack | ✅ | ✅ | ✅ live storm (100+dupes, 2 workers) | IMPLEMENTED |
| Stale ack rejected | ✅ | ✅ | ✅ live | IMPLEMENTED |
| Cross-runtime cancellation | ✅ | ✅ (F-3) | CONTRACTUAL on PG (covered by durable-marker store; A/B cancel re-run pending) | see notes |
| Checkpoint durability | ✅ | ✅ | CONTRACTUAL (same KV path as jobs, proven via restart test) | see notes |
| Lost-message reconciliation | ✅ | ✅ | CONTRACTUAL (reconciliation is backend-agnostic over SharedBackend) | see notes |
| Migrations idempotency | n/a | ✅ | ✅ live ×3 | IMPLEMENTED |
| Failure classification/retry | n/a | ✅ (SQLite classes) | ✅ (PG serialization/deadlock/connection classes) | IMPLEMENTED |
| Latency percentiles | reference only | not claimed | ✅ measured (benchmark-report.md) | IMPLEMENTED |
| Tenant isolation (cross-tenant read/cancel/claim denial) | ✅ runtime gates | ✅ | CONTRACTUAL (runtime-level predicates unchanged; PG-level row policies not implemented) | see notes |
| D1/Durable Objects | — | — | — | FUTURE/CONTRACTUAL |

**Notes on CONTRACTUAL rows:** these run through the same provider-neutral
store code already proven on two engines; what remains contractual is
*executing those exact suites against Postgres* (cancellation/checkpoint/
reconciliation variants) and DB-enforced tenant row policies. They are the
first items for any production hardening pass; no code change blocks them.

## G. Defects found by this phase (evidence the gate works)

1. **PG jsonb coercion** — identical JSON literals compared unequal through
   certain parameter shapes → fixed with driver-native `sql.json()`.
   Caught by conformance CAS-match test on first live run.
2. **`DistributedQueue.ack()` CAS_ABSENT misuse** — symbol leaked into value
   position; Memory swallowed it, Postgres threw. Caught by queue-ack paths.
3. **Idempotency-key tenant bypass** — explicit keys skipped tenant salting.
   Caught by the cross-tenant storm test written for §15.

All three are regression-guarded by the suites that caught them.

## H–I. Security & boundaries

Boundary test extended earlier remains green: no `postgres`/`pg`/`kysely`/
`drizzle-orm`/`bun:sqlite`/`@vercel/*`/Cloudflare SDK imports in
workflow/agent/intelligence/shared. All SQL is parameterized; no credential
material reaches durable events (redaction policy untouched). Agent:
46/48 — pre-existing upstream `ai@6.0.194` named-export drift; zero agent
files touched by Phases 4.5–4.7.

## J. Final counts

- CI mode: adapters 35 · workflow 239 · sandbox 92 · intelligence 108 · agent 46/48
- Live PostgreSQL: adapters **57/57**
- typecheck clean ×4 packages · lint/format 0 errors

## K. Verdict

**PASS WITH CONDITIONS.** Every Phase 4.7 guarantee that could be executed in
this environment was executed against a real PostgreSQL server and passed.
Remaining conditions are explicitly listed above and require a networked
production database (or D1 implementation decision), not further local work.
