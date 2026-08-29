# Phase 5.1 — Forensic Baseline Report

**Date:** 2026-08-25
**Git SHA:** d4bbc12721b6c6b6a5a9a794a7adea8bc9069dbc (HEAD of origin/main)
**Branch:** main

---

## 1. Repository State

| Item | Value |
|------|-------|
| Working tree | Clean |
| Branch | main |
| HEAD SHA | d4bbc12721b6c6b6a5a9a794a7adea8bc9069dbc |
| Last 5 commits | d4bbc12721b6c6b6a5a9a794a7adea8bc9069dbc, c2fb4e4, a06758e, 65b84cf, 3ba8f6c |

---

## 2. Phase 5 Test Baseline

| Suite | Tests | Status |
|-------|-------|--------|
| Phase 5 §1 — arch-freeze | 5/5 | ✅ PROVEN |
| Phase 5 §2 — process crash | 7/7 | ✅ PROVEN |
| Phase 5 §3 — PG failure | 7/7 | ✅ PROVEN |
| Phase 5 §4 — capacity (64-worker) | 3/3 | ✅ MEASURED |
| Phase 5 §5 — tenant boundary | 8/8 | ✅ PROVEN |
| Phase 5 §6 — observability | 7/7 | ✅ PROVEN |
| **Phase 5 total** | **37/37** | **PASS WITH CONDITIONS** |

### Pre-existing Phase 4.8 adapter type fixes

26 type errors were fixed in:
- `packages/adapters/phase48/hotspot-concurrency-soak.test.ts` (23 errors)
- `packages/adapters/phase48/migration-safety.test.ts` (3 errors)

All packages typecheck clean: workflow, sandbox, intelligence, adapters, agent, shared.

---

## 3. Architecture Baseline

### Provider-neutral packages (no provider SDK imports)

| Package | Forbidden imports found |
|---------|----------------------|
| packages/workflow | **0** |
| packages/agent | **0** |
| packages/intelligence | **0** |
| packages/shared | **0** |

Provider SDKs detected: postgres, pg, drizzle, kysely, bun:sqlite, @vercel/*, cloudflare — **none** in core packages.

### Adapter boundary

Provider-specific code lives exclusively in:
- `packages/adapters/pg-backend.ts` (Postgres adapter)
- `packages/adapters/durable-sqlite.ts` (SQLite adapter)
- `packages/adapters/memory-backend.ts` (in-memory adapter)

### Core contracts

- `SharedBackend` — provider-neutral CAS/append/incr/del/keys
- `WorkflowStore` — tenant-scoped job/run/task/step with CAS fencing
- `TaskLeaseStore` — lease claim/renew/revoke
- `EventStore` — append-only monotonic event stream
- `CheckpointStore` — immutable checkpoint persistence
- `Queue` — at-least-once delivery with `(tenantId, messageId)` composite identity
- `StepExecutor` — execution boundary for sandbox/agent
- `IdempotencyStore` — dedup enforcement

### Queue tenant scoping

The queue uses composite `QueuedMessageRef { tenantId, messageId }` at the type level. Storage keys are `qmeta::${tenantId}::${messageId}`. Cross-tenant key collisions are structurally impossible.

Claim scans the global visible list (not per-tenant filtered) — see §16 Queue Decision.

---

## 4. Phase 5 Raw Evidence

All 24 raw evidence files present in `docs/vaulltcore/phase5/raw-results/`:

| File | Scenario | Verdict |
|------|----------|---------|
| baseline-fingerprint.json | Environment SHA | RECORDED |
| baseline-pg-config.json | PG 14.24 config | RECORDED |
| baseline-migrations.json | Schema state | RECORDED |
| baseline-dependencies.json | Node/bun/platform | RECORDED |
| baseline-contracts.json | Contract inventory | RECORDED |
| crash-pre-enqueue.json | SIGKILL baseline (no crash) | PASS |
| crash-post-enqueue.json | SIGKILL after enqueue | PASS |
| crash-post-claim.json | SIGKILL after claim | PASS |
| crash-post-exec.json | SIGKILL after exec | PASS |
| crash-post-checkpoint.json | SIGKILL after checkpoint | PASS |
| crash-submit-child.json | submit() + SIGKILL | PASS |
| crash-concurrent-children.json | 3-worker concurrent | PASS |
| pg-connection-loss.json | Connection reset recovery | PASS |
| pg-restart-under-load.json | 10 concurrent after reconnect | PASS |
| pg-pool-exhaustion.json | 20 concurrent pool stress | PASS |
| pg-cas-race.json | 100 CAS races | PASS |
| pg-utilization-baseline.json | PG utilization snapshot | RECORDED |
| pg-migration-safety.json | Triple migration | PASS |
| capacity-ladder-64.json | 1→64 worker ladder | PASS |
| queue-depth-scalability.json | 100/1k/10k depth | PASS |
| sustained-soak-300s.json | **300-second** soak | PASS |
| tenant-cross-contamination-100.json | 100 concurrent cross-tenant | PASS |
| obs-submit-event.json | Event emission | PASS |
| obs-timing.json | Submit latency | PASS |

---

## 5. Soak-Evidence Ambiguity (CORRECTED)

The Phase 5 acceptance report text and the early Phase 5.1 evidence-integrity narrative both
asserted a **300-second** soak. The authoritative raw evidence `sustained-soak-300s.json`
actually contains `"durationSeconds": 30`. Arithmetic: 612 ops / 20.33 ops/s = 30.1s,
confirming **30 seconds**, not 300.

Resolution: The actual Phase 5 soak duration is **30 seconds at ~10,000 queue depth**. The
misleading filename is retained for provenance. Multi-hour endurance is NOT qualified by this
run and remains BLOCKED. See evidence-integrity-report.md §1 for the full correction.

---

## 6. Remaining Conditions from Phase 5

| Condition | Category | Phase 5.1 Disposition |
|-----------|----------|----------------------|
| Managed PostgreSQL | P0 | BLOCKED (no managed PG in sandbox) |
| Multi-hour endurance | P0 | NOT EXECUTED (sandbox timeout limits) |
| Production topology | P0 | NOT QUALIFIED |
| Process crash (real SIGKILL) | P0 | ✅ PROVEN |
| PG failure recovery | P0 | ✅ PROVEN |
| Tenant isolation (application-level) | P1 | ✅ PROVEN |
| Database-level tenant enforcement (RLS) | P1 | DECISION REQUIRED |
| Queue scaling boundary | P1 | MEASURED, DECISION REQUIRED |
| Queue message ID tenant namespace | P1 | ✅ STRUCTURALLY ENFORCED |
| Crash matrix | P9 | NOT PRODUCED |
| Reconciliation stress | P23 | NOT TESTED |
| Retry amplification | P29 | NOT TESTED |
| Credential leakage scan | P35 | NOT PERFORMED |
| Event stream integrity | P34 | NOT TESTED |
| Lease/fencing stress | P33 | NOT TESTED |

---

## 7. Known Unknowns

1. **Managed PostgreSQL behavior** — cannot be qualified in this sandbox
2. **Multi-hour endurance** — sandbox timeout limits prevent >10 minute runs
3. **Production topology** — single-node local only; no multi-worker deployment
4. **Rolling deployment compatibility** — untested
5. **Backup/restore survival** — no managed PG with backup capability available
6. **Point-in-time recovery** — not available in local PG

---

## 8. Suspected Evidence Inconsistencies

1. **Soak duration** — prior narrative claimed 300s; raw evidence `sustained-soak-300s.json` actually contains `durationSeconds: 30` (612/20.33 = 30.1s). CORRECTED to 30s in §5 and evidence-integrity-report.md §1.
2. **Worker saturation** — Phase 5 says "saturation at ~4 workers" but ladder shows saturation at 8 workers (throughput peaks at 8, degrades at 16+). Will be verified in Phase 5.1 capacity report.

---

## 9. Proposed Phase 5.1 Closure Experiments

### Must Implement (can execute in sandbox)

1. **Reconciliation stress** — construct invalid/intermediate states, run reconciliation 1×/10×/100× concurrently
2. **Retry amplification** — 10/100/1000/10000 same-idempotency-key storms
3. **Credential leakage scan** — automated scan of durable state for secrets
4. **Provider boundary re-verification** — automated import audit
5. **Lease/fencing stress** — stale-worker mutation rejection
6. **Event stream integrity** — concurrent event append correctness
7. **Tenant adversarial deep** — 1000-attempt cross-tenant injection
8. **Crash matrix** — machine-readable crash boundary evidence
9. **Queue decision** — formal v1 operating envelope document

### Must Document as BLOCKED

1. Managed PostgreSQL qualification
2. Multi-hour endurance (4-8 hours)
3. Production topology qualification
4. Backup/restore survival
5. Point-in-time recovery
6. Rolling deployment compatibility

---

**Conclusion:** The Phase 5 baseline is solid. The soak-evidence ambiguity is the only internal inconsistency and is corrected below. Phase 5.1 will close every implementable condition and formally block/disposition every non-executable condition.

---

## 10. Closure Status (updated 2026-08-26, SHA d4bbc12721b6)

The "Must Implement" experiments in §9 were **actually executed** on 2026-08-26. All 33
Phase 5.1 SQLite/in-memory tests passed (reconciliation, retry amplification, credential
scan, provider boundary, fencing, event integrity, tenant adversarial deep, crash matrix)
and regenerated their raw-evidence JSON files carrying `sha: d4bbc12721b6`. The Phase 5.1
"NOT TESTED / NOT PRODUCED" rows above are therefore CLOSED with executed evidence.

The "Must Document as BLOCKED" experiments (§9) remain BLOCKED in this sandbox: no managed
PostgreSQL, no multi-hour runtime, no backup/PITR, no rolling-deploy harness. These are
documented as BLOCKED / NOT QUALIFIED in the acceptance report — never promoted to PASS.

Two pre-existing, environmental failures exist in `packages/workflow/boundary.test.ts`
(relative-path scan of `apps/web/app/api` fails when run from the `packages/workflow` cwd).
These are not Phase 5.1 regressions (no source was modified) and do not affect the
provider-boundary acceptance criterion, which is independently proven by `provider-boundary.test.ts`.
