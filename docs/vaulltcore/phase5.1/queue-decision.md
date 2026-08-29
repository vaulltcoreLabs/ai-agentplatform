# Phase 5.1 — Queue Decision (§16-18)

**Date:** 2026-08-26
**Git SHA:** d4bbc12721b6c6b6a5a9a794a7adea8bc9069dbc

---

## Decision: OPTION A — Accept queue architecture with hard v1 restriction

---

## 1. Current Queue Behavior

The `DistributedQueue` implementation scans a global `qvisible` list on every `claim()`. Each entry is a composite `(tenantId, messageId)` string. The scan is O(visible-list size).

### Measured Performance

| Workers | Throughput | Behavior |
|---------|-----------|----------|
| 1-8 | ~20 ops/s | No contention |
| 16 | ~15-18 ops/s | Mild contention |
| 32 | ~12-15 ops/s | Moderate contention |
| 64 | ~8-12 ops/s | High contention, errors <30% |

### Queue Depth Performance

| Depth | Claim p50 | Claim p99 |
|-------|----------|----------|
| 100 | <1ms | <2ms |
| 1,000 | <2ms | <10ms |
| 10,000 | <5ms | <500ms |

---

## 2. Why OPTION A (Not Redesign)

**Arguments for acceptance:**

1. **Correctness is proven** — 37/37 Phase 5 tests + 33/33 Phase 5.1 tests pass
2. **The actual workload is AI-dominated** — real steps take seconds to minutes (model calls), not milliseconds. Queue overhead is negligible compared to execution time.
3. **Saturation at ~8 workers** is acceptable for v1 — the system handles 3-5 concurrent jobs comfortably
4. **FOR UPDATE SKIP LOCKED in Postgres adapter** can dramatically improve claim performance without changing the Queue contract
5. **The contract already documents** the O(visible) cost and recommends set-based claims

**Arguments against redesign:**

1. Redesign introduces risk of correctness regression
2. The current queue has been chaos-tested with real SIGKILL, concurrent stress, and 300s soak
3. A redesign would require re-proving all 57 experiments

---

## 3. V1 Operating Envelope

| Parameter | Value | Enforcement |
|-----------|-------|-------------|
| Recommended max workers | 8 | Documented |
| Maximum safe workers | 16 | Throughput degrades but no correctness failure |
| Queue depth soft limit | 10,000 | Claim latency stays <5s p99 |
| Queue depth hard limit | 100,000 | UNTESTED — do not exceed without Postgres adapter |

---

## 4. Tenant-Scoped Queue Identity (§18)

**Status: STRUCTURALLY ENFORCED**

The queue uses `QueuedMessageRef { tenantId, messageId }` at the type level. Storage keys are:

```
qmeta::${tenantId}::${messageId}
qinflight::${tenantId}::${workerId}::${messageId}
qdead::${tenantId}::${messageId}
```

Cross-tenant message-ID collisions are **structurally impossible** — the composite key prevents it at the storage layer.

Evidence: `adv-queue-id-collision.json` (Phase 5.1 §20) — same messageId across 3 tenants, zero cross-contamination.

---

## 5. Queue Fairness (§17)

**Status: NOT ENFORCED — Documented as acceptable for v1**

The current queue does not enforce per-tenant fairness. A tenant with a massive queue can delay visibility for other tenants because `claim()` scans the global visible list.

**Mitigation:**

- In practice, the queue is used for durable job dispatch, not high-throughput message streaming
- Each job generates one queue message, processed in seconds
- Cross-tenant starvation is unlikely with <100 concurrent tenants

**Recommendation for v2:** If multi-tenant fairness becomes a requirement, implement per-tenant visible lists with round-robin claiming.

---

## 6. What Would Change This Decision

The queue architecture would need redesign if:

1. Tenant count exceeds 1000 with >100 concurrent jobs each
2. Individual step execution drops below 100ms (making queue overhead dominant)
3. The queue is used for high-frequency messaging (>10k messages/second)
4. Per-tenant SLA enforcement becomes a contractual requirement

None of these conditions apply to the current Vaulltcore v1 architecture.
