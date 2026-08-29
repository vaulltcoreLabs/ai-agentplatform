# Phase 4.6 — Benchmark Report

**Principle honored:** no numbers are invented; no production scalability is
claimed from single-process or dev-server measurements.

## Measured (this workspace, SQLite adapter)

Conformance-suite timing under Bun, two independent connections:

| Operation | Observation |
| --- | --- |
| CAS race (2 connections) | ~2–3 ms per resolved pair |
| 50 concurrent appends (2 connections) | ~11–20 ms total (~0.3 ms/op) |
| 50 concurrent incr (2 connections) | ~11–16 ms total (~0.25 ms/op) |
| Full conformance suite (18 tests) | ~320–360 ms |

Percentiles are not reported: sample sizes here prove **semantics**, not
latency SLAs. p50/p95/p99 tables would be theater at n=50.

## Not measured — CONTRACTUAL/FUTURE

| Target | Status | Blocked on |
| --- | --- | --- |
| Postgres p50/p95/p99 (CAS/append/incr/claim/enqueue/getJob) | FUTURE | live Postgres server in the sandbox (`VAULLTCORE_TEST_POSTGRES_URL` runs the suite + benchmarks when provided) |
| Worker-count scaling curves (1→16 workers) | FUTURE | multi-process harness + networked DB |
| Hotspot analysis (event-stream contention, queue visibility index) | CONTRACTUAL | design documented (`database-model.md`: contention is key-level row locks only; no global lock exists anywhere in the schema) |
| Networked-production vs local-database latency delta | FUTURE | production deployment |

## Explicit non-claims

- No claim of "millions of users" capacity.
- No claim that SQLite throughput predicts Postgres throughput.
- No claim of exactly-once execution: the system guarantees **at-least-once
  execution with idempotent side effects**, unchanged from Phase 4.1.
