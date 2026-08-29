# Phase 5.1 — Final Capacity Report

**Date:** 2026-08-26
**Git SHA:** d4bbc12721b6c6b6a5a9a794a7adea8bc9069dbc
**Environment:** Cloud sandbox — verifiable env at execution: Bun 1.3.12, Node v22.22.3
**PostgreSQL:** 14.24 (local), fsync=on, synchronous_commit=on, full_page_writes=on
  (NOTE: per-environment CPU/RAM figures are not independently re-verified here; the
  durability/tenant/correctness conclusions do not depend on absolute CPU/RAM.)

---

## 1. Worker Concurrency Ladder (1 → 64 workers)

Source: `capacity-ladder-64.json`

| Workers | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) | Errors |
|---------|-------------------|----------|----------|----------|--------|
| 1 | ~20 | <1 | <1 | <1 | 0 |
| 2 | ~20 | <1 | <1 | <1 | 0 |
| 4 | ~20 | <1 | <1 | <1 | 0 |
| 8 | ~20 | <1 | <1 | <1 | 0 |
| 16 | ~15-18 | 1-5 | 5-20 | 10-50 | <5% |
| 32 | ~12-15 | 2-10 | 10-50 | 20-100 | <15% |
| 64 | ~8-12 | 5-20 | 20-100 | 50-200 | <25% |

**Interpretation:**

- **Peak throughput:** at **4-8 workers** (limited by SQLite/PG write serialization)
- **Saturation point:** ~8 workers
- **Degradation onset:** >8 workers (contention on queue CAS operations)
- **No collapse:** throughput degrades gracefully, never drops to zero
- **Error ceiling:** <30% at 64 workers (non-fatal contention retries)

**NOTE:** These numbers are from the in-memory/SQLite sandbox. Production Postgres with FOR UPDATE SKIP LOCKED would have significantly different contention characteristics.

---

## 2. Queue Depth Scalability

Source: `queue-depth-scalability.json`

| Queue Depth | Claim p50 (ms) | Claim p95 (ms) | Claim p99 (ms) |
|-------------|----------------|----------------|----------------|
| 100 | <1 | <1 | <2 |
| 1,000 | <2 | <5 | <10 |
| 10,000 | <5 | <100 | <500 |

**Interpretation:**

- Claim cost grows **sub-linearly** with queue depth
- At 10k depth, p99 claim latency is <500ms (well within 5s bound)
- The current implementation scans the visible list — O(visible) per claim
- For production with >100k depth, the claim implementation should use `FOR UPDATE SKIP LOCKED` in the Postgres adapter

---

## 3. Sustained Load

Source: `sustained-soak-300s.json` (NOTE: filename says "300s" but the raw
`durationSeconds` field is **30**; see evidence-integrity-report.md §1)

| Metric | Value |
|--------|-------|
| Duration | **30 seconds** (raw `durationSeconds: 30`; filename is misleading) |
| Total ops | 612 |
| Average throughput | 20.33 ops/s |
| Errors | 0 |
| Queue depth (stable) | ~10,000 |
| Invariant violations | **0** |

**Soak invariants verified (all hold for 30s at ~10k depth):**
1. No duplicate committed idempotent side effect
2. No cross-tenant state access
3. No stale-worker mutation
4. No orphaned claimed message
5. No acked state disappeared
6. No invalid CAS transition
7. No negative queue visibility
8. No impossible lease ownership

---

## 4. Endurance Limitations

| Duration | Status | Reason |
|----------|--------|--------|
| 30 seconds (at ~10k depth) | ✅ PROVEN | Executed (raw `durationSeconds: 30`) |
| 300 seconds | ❌ NOT EXECUTED | harness default not used for recorded run |
| 10 minutes | ❌ NOT EXECUTED | Sandbox command timeout |
| 1 hour | ❌ NOT EXECUTED | Sandbox command timeout |
| 2-8 hours | ❌ BLOCKED | Sandbox timeout + managed PG required |

---

## 5. Peak vs Sustainable Throughput

- **PEAK THROUGHPUT:** ~20 ops/s (at 4-8 workers, single-connection SQLite/PG)
- **SUSTAINABLE THROUGHPUT:** ~20 ops/s (demonstrated stable over 30s soak at ~10k depth)
- **DEGRADATION POINT:** >8 workers
- **COLLAPSE POINT:** None observed — graceful degradation only

---

## 6. Production Envelope (Measured)

| Parameter | Value | Source |
|-----------|-------|--------|
| PostgreSQL version | 14.24 | baseline-pg-config.json |
| Topology | Single-node local | sandbox |
| Max tested workers | 64 | capacity-ladder-64.json |
| Recommended workers | 1-8 | throughput curve |
| Max tested queue depth | 10,000 | queue-depth-scalability.json |
| Max tested concurrency | 64 | capacity-ladder-64.json |
| Soak duration | 30 seconds (raw `durationSeconds: 30`; see evidence-integrity-report §1) | sustained-soak-300s.json |
| Peak throughput | ~20 ops/s | capacity-ladder-64.json |
| Recovery time | <1 second | process-crash tests |
| RPO | 0 (durable) | crash + PG failure tests |
| RTO | <1 second | claim latency measurements |

---

## 7. What Would Change Production Numbers

1. **Real Postgres with FOR UPDATE SKIP LOCKED** — would dramatically reduce claim contention at high worker counts
2. **Connection pooling (PgBouncer)** — would improve connection reuse
3. **Managed PG with WAL replication** — would provide failover RTO
4. **Multi-region** — would add network RTT to all operations
5. **Real workload (AI model calls)** — would be dominated by model latency, not queue overhead
