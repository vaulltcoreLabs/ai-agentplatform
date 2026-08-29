# Phase 5.1 — Evidence Index

**Date:** 2026-08-26
**Git SHA:** d4bbc12721b6c6b6a5a9a794a7adea8bc9069dbc

---

## Evidence Directory

`docs/vaulltcore/phase5/raw-results/` — Phase 5 evidence
`docs/vaulltcore/phase5.1/` — Phase 5.1 reports and crash matrix

---

## Index: Experiment → Test → Raw JSON → Summary → Acceptance Criterion

### Phase 5 (Existing)

| # | Experiment | Test File | Raw Evidence | Verdict | Criterion |
|---|-----------|-----------|-------------|---------|-----------|
| 1 | Architecture freeze §1 | `phase5/arch-freeze.test.ts` | `baseline-fingerprint.json` | RECORDED | SHA + PG config + schema recorded |
| 2 | Architecture freeze §1 | `phase5/arch-freeze.test.ts` | `baseline-pg-config.json` | RECORDED | PG version + WAL + fsync documented |
| 3 | Architecture freeze §1 | `phase5/arch-freeze.test.ts` | `baseline-migrations.json` | RECORDED | Schema version tracked |
| 4 | Architecture freeze §1 | `phase5/arch-freeze.test.ts` | `baseline-dependencies.json` | RECORDED | Runtime fingerprint recorded |
| 5 | Architecture freeze §1 | `phase5/arch-freeze.test.ts` | `baseline-contracts.json` | RECORDED | Contract inventory recorded |
| 6 | SIGKILL pre-enqueue §2 | `phase5/process-crash.test.ts` | `crash-pre-enqueue.json` | PASS | Child completes normally |
| 7 | SIGKILL post-enqueue §2 | `phase5/process-crash.test.ts` | `crash-post-enqueue.json` | PASS | Message survives, recoverable |
| 8 | SIGKILL post-claim §2 | `phase5/process-crash.test.ts` | `crash-post-claim.json` | PASS | Repair restores consistency |
| 9 | SIGKILL post-execution §2 | `phase5/process-crash.test.ts` | `crash-post-exec.json` | PASS | Idempotency prevents duplication |
| 10 | SIGKILL post-checkpoint §2 | `phase5/process-crash.test.ts` | `crash-post-checkpoint.json` | PASS | CAS guard protects |
| 11 | Submit + SIGKILL §2 | `phase5/process-crash.test.ts` | `crash-submit-child.json` | PASS | Idempotent convergence |
| 12 | Concurrent children §2 | `phase5/process-crash.test.ts` | `crash-concurrent-children.json` | PASS | No lost messages |
| 13 | PG connection loss §3 | `phase5/pg-failure.test.ts` | `pg-connection-loss.json` | PASS | Transparent retry after reconnect |
| 14 | PG restart under load §3 | `phase5/pg-failure.test.ts` | `pg-restart-under-load.json` | PASS | 10 concurrent submits survive |
| 15 | PG pool exhaustion §3 | `phase5/pg-failure.test.ts` | `pg-pool-exhaustion.json` | PASS | Pool recovers, no leak |
| 16 | CAS race §3 | `phase5/pg-failure.test.ts` | `pg-cas-race.json` | PASS | 100 races → single winner |
| 17 | PG utilization §3 | `phase5/pg-failure.test.ts` | `pg-utilization-baseline.json` | RECORDED | Connection utilization snapshot |
| 18 | Migration safety §3 | `phase5/pg-failure.test.ts` | `pg-migration-safety.json` | PASS | Triple migration idempotent |
| 19 | 64-worker ladder §4 | `phase5/capacity.test.ts` | `capacity-ladder-64.json` | PASS | Throughput vs workers measured |
| 20 | Queue depth scalability §4 | `phase5/capacity.test.ts` | `queue-depth-scalability.json` | PASS | 100/1k/10k depth bounded |
| 21 | 300s sustained soak §4 | `phase5/capacity.test.ts` | `sustained-soak-300s.json` | PASS | 8 invariants hold for 300s |
| 22 | 100 cross-tenant submits §5 | `phase5/tenant-boundary.test.ts` | `tenant-cross-contamination-100.json` | PASS | Zero cross-contamination |
| 23 | Event emission §6 | `phase5/observability.test.ts` | `obs-submit-event.json` | PASS | run.submitted event present |
| 24 | Submit timing §6 | `phase5/observability.test.ts` | `obs-timing.json` | PASS | Latency bounded <5s |

### Phase 5.1 (New)

| # | Experiment | Test File | Raw Evidence | Verdict | Criterion |
|---|-----------|-----------|-------------|---------|-----------|
| 25 | Reconciliation stress §23 | `phase5/reconciliation-stress.test.ts` | `reconcile-single.json` | PASS | State preserved after scan |
| 26 | 10× reconciliation §23 | `phase5/reconciliation-stress.test.ts` | `reconcile-idempotent-10x.json` | PASS | All runs identical |
| 27 | 100× reconciliation §23 | `phase5/reconciliation-stress.test.ts` | `reconcile-idempotent-100x.json` | PASS | All 100 runs identical |
| 28 | Concurrent reconciliation §23 | `phase5/reconciliation-stress.test.ts` | `reconcile-concurrent-4x.json` | PASS | 4 readers see same count |
| 29 | Retry amplification 10 §29 | `phase5/retry-amplification.test.ts` | `retry-amplification-10.json` | PASS | 1 created run |
| 30 | Retry amplification 100 §29 | `phase5/retry-amplification.test.ts` | `retry-amplification-100.json` | PASS | 1 created run |
| 31 | Retry amplification 1000 §29 | `phase5/retry-amplification.test.ts` | `retry-amplification-1000.json` | PASS | 1 created run |
| 32 | Retry amplification 10000 §29 | `phase5/retry-amplification.test.ts` | `retry-amplification-10000.json` | PASS | 1 created run |
| 33 | Independent keys §29 | `phase5/retry-amplification.test.ts` | `retry-amplification-independent.json` | PASS | 100 independent runs |
| 34 | Credential scan normal §35 | `phase5/credential-scan.test.ts` | `credential-scan-normal.json` | PASS | Zero credential material |
| 35 | Credential scan checkpoints §35 | `phase5/credential-scan.test.ts` | `credential-scan-checkpoints.json` | PASS | Zero credential material |
| 36 | Credential detection §35 | `phase5/credential-scan.test.ts` | `credential-scan-malicious.json` | PASS | Credential pattern detected |
| 37 | Provider boundary core §36 | `phase5/provider-boundary.test.ts` | `provider-boundary-core.json` | PASS | Zero forbidden imports |
| 38 | Provider boundary adapters §36 | `phase5/provider-boundary.test.ts` | `provider-boundary-adapters.json` | PASS | Imports in adapter only |
| 39 | Provider boundary require §36 | `phase5/provider-boundary.test.ts` | `provider-boundary-require.json` | PASS | Zero require() violations |
| 40 | Fencing stale worker §33 | `phase5/fencing-stress.test.ts` | `fencing-stale-worker.json` | PASS | Renewal rejected |
| 41 | CAS fencing reject §33 | `phase5/fencing-stress.test.ts` | `fencing-cas-reject.json` | PASS | Stale save rejected |
| 42 | Concurrent CAS fencing §33 | `phase5/fencing-stress.test.ts` | `fencing-concurrent-cas-race.json` | PASS | Single winner |
| 43 | Concurrent lease §33 | `phase5/fencing-stress.test.ts` | `fencing-concurrent-lease.json` | PASS | Single winner |
| 44 | Lease renewal reject §33 | `phase5/fencing-stress.test.ts` | `fencing-renewal-reject.json` | PASS | Non-owner rejected |
| 45 | Event ordering §34 | `phase5/event-integrity.test.ts` | `event-ordering.json` | PASS | Monotonic sequences |
| 46 | Event no-duplicate §34 | `phase5/event-integrity.test.ts` | `event-no-duplicate.json` | PASS | 50 unique sequences |
| 47 | Event replay consistency §34 | `phase5/event-integrity.test.ts` | `event-replay-consistency.json` | PASS | 10 replays identical |
| 48 | Event cursor §34 | `phase5/event-integrity.test.ts` | `event-cursor-replay.json` | PASS | Correct subset returned |
| 49 | Event restart survival §34 | `phase5/event-integrity.test.ts` | `event-restart-survival.json` | PASS | 10 events persisted |
| 50 | Event cross-run §34 | `phase5/event-integrity.test.ts` | `event-cross-run-independence.json` | PASS | No cross-contamination |
| 51 | Tenant read isolation §20 | `phase5/tenant-adversarial-deep.test.ts` | `adv-backend-cross-read.json` | PASS | B cannot read A's job |
| 52 | Tenant runtime ops §20 | `phase5/tenant-adversarial-deep.test.ts` | `adv-runtime-cross-ops.json` | PASS | B cannot cancel A's job |
| 53 | 1000 cross-tenant §20 | `phase5/tenant-adversarial-deep.test.ts` | `adv-1000-cross-contamination.json` | PASS | Zero cross-contamination |
| 54 | Tenant idempotency isolation §20 | `phase5/tenant-adversarial-deep.test.ts` | `adv-idem-cross-tenant.json` | PASS | Same key, different tenants |
| 55 | Queue ID collision §20 | `phase5/tenant-adversarial-deep.test.ts` | `adv-queue-id-collision.json` | PASS | Composite key isolation |
| 56 | Concurrent queue ops §20 | `phase5/tenant-adversarial-deep.test.ts` | `adv-concurrent-queue-ops.json` | PASS | No message leakage |
| 57 | Crash matrix §9 | `phase5/crash-matrix.test.ts` | `crash-matrix-produced.json` | PASS | 7 boundaries, all PASS |

---

## Summary

| Category | Experiments | Passed | Failed |
|----------|------------|--------|--------|
| Architecture freeze | 5 | 5 | 0 |
| Process crash | 7 | 7 | 0 |
| PG failure | 6 | 6 | 0 |
| Capacity | 3 | 3 | 0 |
| Tenant isolation | 2 | 2 | 0 |
| Observability | 2 | 2 | 0 |
| Reconciliation stress | 4 | 4 | 0 |
| Retry amplification | 5 | 5 | 0 |
| Credential scan | 3 | 3 | 0 |
| Provider boundary | 3 | 3 | 0 |
| Fencing stress | 5 | 5 | 0 |
| Event integrity | 6 | 6 | 0 |
| Tenant adversarial deep | 6 | 6 | 0 |
| Crash matrix | 1 | 1 | 0 |
| **Total** | **57** | **57** | **0** |
