# Phase 4.7 — Production Durability, Concurrency & Capacity Gate

**Verdict: PASS WITH CONDITIONS** (see `acceptance-report.md`)
**Date:** 2026-08-24 · **Scope:** close the Phase 4.6 contractual conditions with
a live PostgreSQL server, real concurrency, failure injection, and measured
latency percentiles. No Phase 5, no product/UI work, no rewrites of Phases
1–4.6.

## What this phase did

Phase 4.6 left one contractual condition: *"Postgres conformance is gated
behind `VAULLTCORE_TEST_POSTGRES_URL`."* Phase 4.7 provisioned a real
PostgreSQL 14 server inside the workspace and executed the gate for real.

1. **Live-Postgres conformance** — `describeSharedBackendConformance`
   executed against `PostgresSharedBackend` over an actual server: 9/9.
   This immediately caught a real adapter defect (see below) that no amount of
   SQLite testing could have surfaced.
2. **Distributed durability gate** — new `pg-durable.test.ts`: migrations
   idempotency, high-contention CAS races (2/4/8/16 workers), lease
   expiry/takeover/stale-renew rejection, idempotent submission storms,
   cross-tenant key isolation, 200-way concurrent increments and 100-way
   concurrent appends across 4 independent connections, a 100-message queue
   storm with duplicates/visibility timeouts/permanent acks, and durable-state
   survival across connection termination.
3. **Benchmark harness** — p50/p95/p99/max latency table for every
   SharedBackend + queue operation at several concurrency levels. Real numbers
   only; see `benchmark-report.md`.
4. **Real defects found by the live database — all fixed:**

| # | Defect | Where | Why Memory hid it |
|---|--------|-------|-------------------|
| 1 | Driver text→jsonb implicit cast compared identical JSON literals unequal in some query shapes | `pg-backend.ts` | N/A (SQLite adapter used its own typing correctly) |
| 2 | `DistributedQueue.ack()` passed the `CAS_ABSENT` **symbol** through as a value into `cas()` | `workflow/distributed-store.ts` | Memory backend silently swallowed symbol-valued writes |
| 3 | Explicit `idempotencyKey` bypassed tenant partitioning → cross-tenant collision vector | `workflow/distributed-runtime.ts` | No cross-tenant storm test existed pre-Phase 4.7 |

All fixes preserve Phase 4.1–4.6 contracts; the full existing suites pass
unchanged.

## How to reproduce

```bash
# Any PostgreSQL 14+ instance works; tests purge only their own tables.
export VAULLTCORE_TEST_POSTGRES_URL="postgres://user:pass@host:5432/vaulltcore_test"
bun test packages/adapters            # conformance + durability gate + benchmarks

# Without the URL everything Postgres-specific is skipped cleanly (CI-safe):
unset VAULLTCORE_TEST_POSTGRES_URL
bun test packages/adapters
```

The local reference path remains dependency-free:
`bun test packages/adapters` runs Memory + SQLite conformance without any
server.

## Results summary

| Suite | CI mode | Live PostgreSQL |
|---|---|---|
| adapters total | 35/35 | **57/57** (+PG conformance 9, durability gate 12, bench 1) |
| workflow | 239/239 | — (same code paths re-proven via PG suites) |
| sandbox / intelligence | 92/92 · 108/108 | — |
| agent | 46/48 | pre-existing upstream `ai@6.0.194` drift, untouched |
| typecheck (adapters/workflow/sandbox/intelligence) | clean | clean |
| lint + format (oxlint/oxfmt) | 0 errors | 0 errors |

## Status classification

- **IMPLEMENTED:** live-Postgres conformance, distributed durability gate,
  benchmark harness with percentile reporting, failure classification +
  bounded jittered retry, migration idempotency on a real server.
- **CONTRACTUAL:** managed/networked production Postgres (local Unix-socket
  latencies are not network RTT numbers); Cloudflare D1/Durable Objects
  mapping (decision: remain contractual — see acceptance report §D1).
- **FUTURE:** WebSocket runner transport, durable runner credential store,
  warm pools, BYOS, large-scale load testing, Phase 5.
