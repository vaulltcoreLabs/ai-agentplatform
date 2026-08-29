# Phase 4.6 — Acceptance Report

**Date:** 2026-08-24
**Verdict: PASS WITH CONDITIONS** — all semantics proven on SQLite + Memory;
Postgres adapter implemented but its conformance run is CONTRACTUAL until
executed against a live server.

## Capability matrix

| Capability | Status | Evidence |
| --- | --- | --- |
| SharedBackend contract preserved | IMPLEMENTED | `packages/adapters/conformance.ts`; 18/18 suite |
| CAS (create/update/conflict/stale-reject) | IMPLEMENTED (SQLite+Memory) / CONTRACTUAL (PG) | conformance tests; PG SQL single-statement design |
| Version fencing | IMPLEMENTED | stale-expected rejection; workflow 239/239 incl. fencing suites |
| Idempotency | IMPLEMENTED (SQLite) / CONTRACTUAL (PG) | F-2 dup-submit across two connections; DB uniqueness via PK |
| Event append atomicity | IMPLEMENTED (SQLite) / CONTRACTUAL (PG) | 50-way concurrent append completeness |
| Atomic increment | IMPLEMENTED (SQLite) / CONTRACTUAL (PG) | 50-way unique allocation; PG native `RETURNING counter` |
| Queue semantics | PRESERVED (Phase 4.1 code) | durable-sqlite queue tests: dedup/visibility/ack/retry |
| Cancellation cross-runtime | IMPLEMENTED (SQLite) | F-3 marker visibility across independent connections |
| Checkpoints | PRESERVED | Phase 4.1/4.4 checkpoint suites green |
| Leases | PRESERVED | Phase 4.1 lease/fencing suites green |
| Tenant isolation | IMPLEMENTED at persistence boundary | key-namespace PK; prefix-scan isolation test |
| Failure recovery (classification/retry) | IMPLEMENTED | retry.test.ts: transient retried bounded; permanent first-attempt |
| Postgres adapter | CONTRACTUAL | implemented (`pg-backend.ts`, migrations); gated suite skips without live URL |
| D1/DO adapter | FUTURE | mapping documented; not implemented this phase |
| Conformance suite | IMPLEMENTED | shared factory-driven suite over Memory + SQLite (+PG gated) |
| Performance benchmarks | PARTIAL — honest | SQLite timings only; percentiles explicitly not fabricated |
| Security | PRESERVED + AUDITED | parameterized-only SQL; no secrets in errors; Phase 4.3 policy untouched |
| Runner compatibility | PRESERVED | runner-protocol suites green; fencing model unchanged |
| Boundary enforcement | STRENGTHENED | postgres/pg/kysely/drizzle/bun:sqlite banned in core |

## Test counts

adapters 35/35 · workflow 239/239 · sandbox 92/92 · intelligence 108/108 ·
agent 46/48 (**pre-existing** upstream `ai@6.0.194` `tool` export drift —
untouched by this phase, tracked as known limitation). Typecheck clean:
workflow/sandbox/adapters/agent. Lint/format: 0 errors.

## Known limitations

1. Postgres conformance unexecuted in this environment (no live server).
2. D1/Durable Objects split documented but not implemented.
3. Percentile latency benchmarks require production infrastructure.
4. Two pre-existing agent test failures from upstream SDK drift.

## Recommended next phase (4.7)

Run Postgres conformance against a real server (CI service container is
sufficient), then implement benchmark harness + D1 adapter.
