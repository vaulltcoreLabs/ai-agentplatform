# Phase 6 — Multi-Region Deployment Architecture

## Design Principles

1. **SharedBackend is the unit of distribution.** The existing provider-neutral
   `SharedBackend` contract (CAS / append / incr / del / keys / repair) is the
   single abstraction that separates "one region" from "multi-region." A
   multi-region deployment swaps the adapter, not the contracts, stores, or
   runtime.

2. **CAS always routes to primary.** Compare-and-swap is the correctness
   primitive for leases, fencing, and idempotency. It requires linearizable
   consistency and must be served by the authoritative write leader. All other
   reads may be served from local replicas with bounded staleness.

3. **Workers are stateless.** A worker process in any region can process any
   step for any tenant, provided it can reach the primary for CAS and a local
   (or remote) replica for reads. No worker holds durable state; no worker is
   "sticky."

4. **Object storage is already global.** Cloudflare R2 is globally
   replicated. Artifact uploads/downloads operate identically from any region.
   The `ArtifactMetadataStore` (Postgres) determines routing; the `ObjectStore`
   (R2) is region-agnostic.

5. **Tenant-to-region affinity is optional, not required.** A tenant may pin
   to a preferred region for latency, but the system must function correctly
   when a tenant's traffic is served from any region. Tenant pinning is a
   performance optimization, not a correctness requirement.

---

## Topology

```
                    ┌──────────────────────────────────────┐
                    │            GLOBAL LAYER               │
                    │                                       │
                    │  Cloudflare (DNS / Anycast / WAF)     │
                    │  R2 Object Storage (global, multi-homed)│
                    └────────┬───────────────┬──────────────┘
                             │               │
              ┌──────────────▼──┐   ┌────────▼──────────────┐
              │  REGION A (US)  │   │  REGION B (EU)        │
              │                 │   │                       │
              │  ┌────────────┐ │   │  ┌────────────┐      │
              │  │ Workers    │ │   │  │ Workers    │      │
              │  │ (N replicas)│ │   │  │ (N replicas)│     │
              │  └─────┬──────┘ │   │  └─────┬──────┘      │
              │        │        │   │        │              │
              │  ┌─────▼──────┐ │   │  ┌─────▼──────┐      │
              │  │ Regional   │ │   │  │ Regional   │      │
              │  │ Read       │ │   │  │ Read       │      │
              │  │ Replica    │ │   │  │ Replica    │      │
              │  └─────┬──────┘ │   │  └─────┬──────┘      │
              │        │        │   │        │              │
              └────────┼────────┘   └────────┼──────────────┘
                       │                    │
                 ┌─────▼────────────────────▼─────┐
                 │       NEON PRIMARY (US)         │
                 │                                 │
                 │  vc_kv (SharedBackend)          │
                 │  workflow jobs/runs/steps       │
                 │  artifact metadata              │
                 │  idempotency records            │
                 │  event streams                  │
                 │  queue messages                 │
                 └─────────────────────────────────┘
```

### Component Placement

| Component | Placement | Rationale |
|-----------|-----------|-----------|
| **Workers** | Any region (stateless, N replicas) | CAS + lease fencing make workers disposable; any worker can finish any step |
| **Neon Primary** | Single region (US-East by default) | Authoritative write leader for all CAS, append, incr operations |
| **Neon Read Replicas** | One per active region | Low-latency reads for job status, event replay, checkpoint load; eventual consistency acceptable for these paths |
| **R2 Object Storage** | Global (Cloudflare edge) | Already multi-homed; artifacts accessible from any region at edge latency |
| **Cloudflare DNS/WAF** | Global (anycast) | Request routing to nearest healthy region; DDoS protection |

---

## Data Classification

The existing architecture already separates data into categories with different
consistency requirements. Multi-region deployment leverages this separation:

### Tier 1: Strongly Consistent (Primary-Only)

These operations **must** go to the Neon primary. They use CAS or atomic
single-statement writes where a stale read would cause correctness violations.

| Operation | Contract Method | Why Primary-Only |
|-----------|----------------|------------------|
| Lease claim | `TaskLeaseStore.claim()` | Two workers in different regions must not both claim the same step |
| Lease renew | `TaskLeaseStore.renew()` | Fencing version must reflect latest |
| Step commit (CAS fence) | `DistributedWorkflowStore.saveStep()` | `expectedVersion` must match the authoritative version |
| Step completion (CAS) | `DistributedWorkflowStore.transitionRun()` | State machine transitions must be linearizable |
| Idempotency record | `DistributedIdempotencyStore.record()` | Exactly-once submission requires atomic CAS |
| Cancellation marker | `WorkflowStore.setCancellationMarker()` | Must be visible to all workers immediately |
| Queue claim/ack | `DistributedQueue.claim()` / `.ack()` | Exactly-once delivery; double-claim = double-execution |
| Job save (CAS) | `DistributedWorkflowStore.saveJob()` | Version fencing on job updates |

### Tier 2: Eventual Consistency Acceptable (Replica-Served)

These operations read from a local replica. Staleness is bounded by Neon
replication lag (typically < 200ms for Neon read replicas). A stale read
results in at worst a redundant queue retry, never a correctness violation.

| Operation | Contract Method | Why Replica OK |
|-----------|----------------|----------------|
| Read job status | `WorkflowStore.getJob()` | Status is informational; stale status triggers a retry, not data corruption |
| Read run status | `WorkflowStore.getRun()` | Same — informational reads |
| Event replay | `EventStore.replay()` | Missing the latest event just delays visibility; worker re-polls |
| Checkpoint load | `CheckpointStore.latestForStep()` | Stale checkpoint → resumes from slightly older state; correctness preserved |
| List active runs | `WorkflowStore.listActiveRunIds()` | Reconciliation is inherently best-effort; stale list triggers a re-poll |
| Queue stats | `Queue.stats()` | Dashboard-only; staleness is cosmetic |
| Transitions audit | `WorkflowStore.getTransitions()` | Audit trail; never drives control flow |

### Tier 3: Global (No Routing Required)

| Operation | Component | Why Global |
|-----------|-----------|------------|
| Artifact upload/download | R2 ObjectStore | R2 is globally replicated; presigned URLs work from any region |
| Artifact HEAD/DELETE | R2 ObjectStore | Same — S3-compatible global endpoint |
| DNS resolution | Cloudflare | Anycast routing |

---

## Regional SharedBackend Adapter

The key innovation for multi-region is a `RegionalSharedBackend` that wraps
the existing `PostgresSharedBackend` with routing intelligence:

```typescript
/**
 * Phase 6 — Multi-region SharedBackend adapter.
 *
 * Routes CAS/write operations to the Neon primary (strongly consistent)
 * and read operations to a local Neon read replica (eventually consistent).
 *
 * The adapter implements the SAME SharedBackend contract used everywhere
 * else. The distributed stores (DistributedWorkflowStore, DistributedQueue,
 * etc.) are unchanged.
 *
 * Consistency model:
 *  - CAS / append / incr / del → primary (linearizable)
 *  - get / list / keys → replica (bounded staleness ≤ replication lag)
 *  - appendUnique → primary (atomic marker claim + append)
 */
export class RegionalSharedBackend implements SharedBackend {
  private readonly primary: PostgresSharedBackend;
  private readonly replica: PostgresSharedBackend;

  constructor(config: RegionalBackendConfig) {
    this.primary = PostgresSharedBackend.fromConnectionString(
      config.primaryConnectionString,  // Neon primary (US-East)
    );
    this.replica = PostgresSharedBackend.fromConnectionString(
      config.replicaConnectionString,  // Regional Neon replica (e.g. EU)
    );
  }

  // --- Writes route to PRIMARY (linearizable) ---

  async cas(key: string, expected: CasValue, value: unknown): Promise<boolean> {
    return this.primary.cas(key, expected, value);
  }

  async append(key: string, value: unknown): Promise<void> {
    return this.primary.append(key, value);
  }

  async incr(key: string, by?: number): Promise<number> {
    return this.primary.incr(key, by);
  }

  async del(key: string): Promise<void> {
    return this.primary.del(key);
  }

  async appendUnique(
    key: string,
    dedupKey: string,
    value: unknown,
  ): Promise<{ appended: boolean; existing?: unknown }> {
    return this.primary.appendUnique!(key, dedupKey, value);
  }

  // --- Reads route to REPLICA (eventual consistency) ---

  async get(key: string): Promise<unknown> {
    return this.replica.get(key);
  }

  async list(key: string): Promise<unknown[]> {
    return this.replica.list(key);
  }

  async keys(prefix: string): Promise<string[]> {
    return this.replica.keys(prefix);
  }
}
```

### Why Replica Reads Are Safe

Every correctness-critical path in Vaulltcore already handles the case where
a read returns stale data:

| Stale Read Scenario | Existing Safety Mechanism |
|---------------------|--------------------------|
| `getRun()` returns stale status | Worker sees non-terminal → proceeds normally; queue retry handles it |
| `getStep()` returns stale version | `saveStep()` CAS rejects the stale write; worker re-polls |
| `getCancellationMarker()` misses marker | Worker executes one extra step; next poll catches the marker |
| `replay()` misses latest event | Eventual: next poll or cursor resume picks up the lagging event |
| `listActiveRunIds()` misses a run | Reconciliation is periodic; missed run appears on next cycle |
| `getLease()` returns stale lease | Worker sees expired lease → retries; correct behavior |

The only operations where staleness would cause a correctness violation are
CAS-based operations (claim, commit, idempotency), and those are routed to
primary.

### Replica Lag Budget

Neon read replicas typically replicate within 100-200ms. The system tolerates
this because:

- **Queue visibility timeout**: 30s (150x the expected lag)
- **Lease TTL**: 30s (150x the expected lag)
- **Reconciliation cycle**: configurable, default 10s (50x the expected lag)
- **Worker poll interval**: 100ms-1s (well within lag bounds)

If replica lag exceeds these bounds (Neon incident, network partition), the
system degrades gracefully: workers see stale state and retry, but never
double-execute or lose work.

---

## Regional Queue Design

The existing `DistributedQueue` uses composite `(tenantId, messageId)` keys
with CAS-based claim. In a multi-region deployment:

### Option A: Primary-Only Queue (Phase 6.1 — Recommended Start)

Queue operations (enqueue, claim, ack, retry) route through the primary.
This is simple, correct, and sufficient for <1000 concurrent tenants.

```
Region A Worker → Primary (claim) → execute → Primary (ack)
Region B Worker → Primary (claim) → execute → Primary (ack)
```

**Pros**: Correct by construction; no new distributed coordination.
**Cons**: All claim operations have inter-region latency (~80ms US↔EU).

### Option B: Regional Queue Partitions (Phase 6.3 — Future Scale)

When queue depth or claim latency requires regional independence:

1. **Tenant-to-region affinity**: each tenant is assigned a preferred region
   via `TenantConfig.region`. Queue messages for that tenant are enqueued to
   a regional partition.

2. **Regional queue shards**: each region maintains its own `qvisible` list
   for tenants pinned to that region. Cross-region work is enqueued only when
   the pinned region is unhealthy.

3. **Global reconciliation**: a global reconciler (running in primary region)
   scans all regional partitions and redistributes stale work.

This is deferred until tenant count >1000 or claim p99 >200ms from secondary
regions.

---

## Event Ordering Across Regions

Event append (`EventStore.append()`) uses an atomic `incr` for sequence
allocation. In multi-region:

- **Sequence allocation**: routes to primary (the `incr` is CAS-like).
  This means event appends from secondary regions have primary-round-trip
  latency (~80ms US↔EU).
- **Event replay**: served from local replica. Events may lag by replication
  delay, but ordering is preserved (sequence is monotononic at the primary).
- **appendUnique** (dedup): routes to primary. Atomic marker claim + append
  is a single transaction; correctness depends on linearizability.

**Alternative for write-heavy workloads**: batch event appends locally and
flush to primary in batches. This trades append latency for throughput but
adds complexity. Deferred to Phase 6.3 unless benchmarks show the primary
is a bottleneck.

---

## Failover & Regional Isolation

### Failure Mode 1: Regional Network Partition

When a secondary region cannot reach the primary:

1. **Workers detect primary unreachable**: CAS operations fail with
   connection timeout (configurable, default 5s).
2. **Workers stop accepting new claims**: a regional health check marks
   the region as degraded. Cloudflare DNS stops routing traffic to it.
3. **Workers finish in-flight steps**: any step already claimed continues
   execution (the lease is valid until TTL expires).
4. **Primary region absorbs all traffic**: Cloudflare routes to the healthy
   region. Workers in the primary region pick up the queue.

**No data loss**: CAS operations that fail are retried on the primary.
Workers that lose their primary connection release their leases (or leases
expire via TTL).

### Failure Mode 2: Primary Region Down

This is the critical scenario. Neon primary failure:

1. **Neon promotes a read replica to primary**: automatic failover (Neon
   handles this). New primary is reachable within ~30s.
2. **Workers reconnect**: DNS/config updates point to the new primary.
   Workers resume CAS operations against the promoted replica.
3. **In-flight work**: any step that was mid-execution continues. Its
   lease expires (TTL 30s). A new worker claims the step from the promoted
   primary. The step restarts from its last checkpoint.

**Durability**: Neon's replication is synchronous for committed writes.
RPO = 0 (no data loss). RTO ≈ 30s (Neon failover time).

### Failure Mode 3: Complete Region Loss

Both primary and secondary in one region are lost (extremely rare):

1. **Other regions absorb traffic**: Cloudflare routes to surviving regions.
2. **Neon failover** to a surviving replica (if available) or recovery from
   WAL archiving.
3. **Queue messages**: in-flight messages in the lost region's visibility
   timeout are lost. Reconciliation in surviving regions re-enqueues all
   active runs (idempotent, safe).
4. **Object storage**: R2 is unaffected (global replication).

---

## Tenant Routing & Affinity

### Default: No Affinity

By default, any worker in any region can serve any tenant. This is the
simplest model and works for most deployments.

### Optional: Tenant Pinning

For latency-sensitive tenants, `TenantConfig` gains a `preferredRegion`
field:

```typescript
interface TenantConfig {
  readonly tenantId: TenantId;
  readonly maxConcurrentRuns: number;
  readonly maxConcurrentSteps: number;
  readonly defaultBudget: RunBudget;
  // Phase 6: optional region affinity
  readonly preferredRegion?: string;  // e.g. "us-east", "eu-west"
}
```

When `preferredRegion` is set:
- **Submission routing**: the API layer routes `submit()` to a worker in
  the preferred region.
- **Worker selection**: the queue is partitioned so workers in the preferred
  region claim their pinned tenants' messages first.
- **Failover**: if the preferred region is unhealthy, work falls through to
  any region (same as no-affinity mode).

### Region-Aware Authorization

`assertAuthorized()` and `assertTenantKnown()` are unchanged — they operate
on tenant IDs, not regions. A tenant's region preference is an execution
optimization, not a security boundary. Cross-tenant isolation is enforced
by the `SharedBackend` key partitioning (tenant-prefixed keys), not by
regional placement.

---

## API Layer Routing

The API layer (apps/web) routes requests to the nearest healthy region:

```
Client → Cloudflare Anycast
           │
           ├── Region A (US) healthy → Route here
           └── Region A unhealthy → Region B (EU)
```

### Health Checks

Each region exposes a `/api/health` endpoint that checks:
1. Primary database connectivity (CAS test on a health-check key)
2. Replica lag (via `pg_stat_replication` or Neon's status endpoint)
3. Queue depth (are messages piling up?)

Cloudflare uses these for routing decisions.

### Request Flow

1. **Submit**: API receives `POST /api/workflows/submit` → routes to nearest
   region → `DistributedDurableRuntime.submit()` → CAS on primary → enqueue
   → return.

2. **Status**: API receives `GET /api/workflows/:id` → routes to nearest
   region → `DistributedWorkflowStore.getJob()` → read from **local replica**
   → return. (May be slightly stale; acceptable for status display.)

3. **Cancel**: API receives `POST /api/workflows/:id/cancel` → routes to
   nearest region → `setCancellationMarker()` → **CAS on primary** → return.
   Cancellation marker is immediately visible to all workers (primary read).

4. **Stream events**: API receives `GET /api/workflows/:id/events` → SSE
   connection to nearest region → `EventStore.replay()` → read from local
   replica → stream. Missing events caught by cursor resume on next poll.

---

## Migration Strategy (Single → Multi-Region)

### Phase 6.1: Regional Read Replicas

1. **Add Neon read replica** in target region (e.g. EU).
2. **Deploy `RegionalSharedBackend`** adapter alongside the existing
   `PostgresSharedBackend`. Configuration determines which adapter is used.
3. **Workers in secondary region** use `RegionalSharedBackend` (reads from
   local replica, writes to primary).
4. **Workers in primary region** continue using `PostgresSharedBackend`
   directly (primary = local).
5. **Measure**: replica lag, CAS latency from secondary, queue claim latency.

### Phase 6.2: Traffic Routing

1. **Cloudflare load balancing** routes API traffic to nearest healthy
   region.
2. **Health checks** ensure routing fails over within 30s.
3. **Tenant pinning** (optional) for latency-sensitive tenants.

### Phase 6.3: Regional Queue Partitioning

1. **Tenant-to-region affinity** in `TenantConfig`.
2. **Regional queue shards** with global reconciliation.
3. **Benchmark**: verify claim latency improvement, queue fairness.

### Phase 6.4: Primary Failover Hardening

1. **Neon HA** (automatic replica promotion) verified under load.
2. **Chaos testing**: primary kill → verify recovery within RTO.
3. **Multi-AZ Neon** for intra-region redundancy.

---

## Consistency Guarantees (Multi-Region)

| Property | Single-Region (Phases 1–5) | Multi-Region (Phase 6) | Change |
|----------|---------------------------|----------------------|--------|
| CAS linearizability | ✅ Strong | ✅ Strong (primary-routed) | None |
| Lease exclusive ownership | ✅ Proven | ✅ Proven (CAS on primary) | None |
| Event monotonic ordering | ✅ Proven | ✅ Proven (incr on primary) | None |
| Exactly-once idempotency | ✅ Proven | ✅ Proven (CAS on primary) | None |
| Job/run status freshness | ✅ Strong | ⚠️ Eventually consistent (≤200ms lag) | Acceptable |
| Event replay freshness | ✅ Strong | ⚠️ Eventually consistent (≤200ms lag) | Acceptable |
| Cancellation propagation | ✅ Immediate | ✅ Immediate (CAS on primary) | None |
| Queue delivery | ✅ At-least-once | ✅ At-least-once (claim on primary) | None |
| Cross-tenant isolation | ✅ Proven (1100+ attempts) | ✅ Proven (same key partitioning) | None |
| RPO | 0 | 0 (Neon sync replication) | None |
| RTO | <1s | <30s (Neon failover) | Acceptable |

**The only changes are to non-critical reads (status, events), which are
eventually consistent within bounded lag. All correctness-critical operations
(routing to primary) remain strongly consistent.**

---

## Configuration

```typescript
interface MultiRegionConfig {
  /** Neon primary connection string (writes). */
  readonly primaryConnectionString: string;
  /** Neon read replica connection string (reads). */
  readonly replicaConnectionString: string;
  /** Region identifier for this deployment. */
  readonly regionId: string;  // e.g. "us-east", "eu-west"
  /** List of all known regions for routing. */
  readonly knownRegions: ReadonlyArray<{
    readonly id: string;
    readonly primaryConnectionString: string;
    readonly replicaConnectionString: string;
  }>;
  /** Maximum acceptable replica lag before marking region degraded (ms). */
  readonly maxReplicaLagMs: number;  // default 5000
  /** Health check interval (ms). */
  readonly healthCheckIntervalMs: number;  // default 10000
  /** Optional: per-tenant region affinity. */
  readonly tenantAffinity?: ReadonlyMap<TenantId, string>;
}
```

---

## Test Strategy (Phase 6)

### Unit Tests (packages/adapters/phase6/)

| Test | Description |
|------|-------------|
| `regional-backend.test.ts` | `RegionalSharedBackend` routes writes to primary, reads to replica |
| `regional-backend-failover.test.ts` | Simulate primary unreachable → verify failover behavior |
| `regional-backend-lag.test.ts` | Inject replica lag → verify bounded staleness handling |
| `regional-queue.test.ts` | Queue operations across primary/replica routing |
| `regional-tenant-routing.test.ts` | Tenant pinning and cross-region work distribution |

### Integration Tests (requires multi-region Neon)

| Test | Description |
|------|-------------|
| `cross-region-cas.test.ts` | CAS from Region B against primary in Region A |
| `cross-region-lease.test.ts` | Lease claim in Region A, commit rejected in Region B |
| `cross-region-event-ordering.test.ts` | Events appended from both regions maintain global ordering |
| `primary-failover.test.ts` | Neon primary failover during active work |
| `replica-promotion.test.ts` | Read replica promoted to primary under load |

### Chaos Tests

| Test | Description |
|------|-------------|
| `chaos-network-partition.test.ts` | Region-to-primary partition; verify graceful degradation |
| `chaos-region-loss.test.ts` | Complete region loss; verify work resumption in surviving region |
| `chaos-replica-stale.test.ts` | Extreme replica lag (5s+); verify correctness via retry paths |

---

## Performance Envelope (Multi-Region)

### Expected Latency Additions

| Operation | Single-Region | Multi-Region (cross-region) | Overhead |
|-----------|--------------|---------------------------|----------|
| CAS (write to primary) | <1ms | 60-100ms (US↔EU) | +60-99ms |
| Queue claim (primary) | <1ms | 60-100ms (US↔EU) | +60-99ms |
| Job status read (replica) | <1ms | <1ms (local replica) | ~0 |
| Event replay (replica) | <1ms | <1ms (local replica) | ~0 |
| Artifact upload (R2) | ~10ms | ~10ms (R2 global) | ~0 |

### Throughput Impact

At 8 workers per region, cross-region CAS overhead adds ~100ms per step
cycle. With a 30s lease TTL and ~5s average step duration, this represents
<2% throughput reduction per step. Acceptable for the consistency guarantee.

For workloads where CAS latency is unacceptable, Phase 6.3 regional queue
partitioning eliminates cross-region CAS for queue operations (claim/ack
route to the regional queue shard; only reconciliation touches primary).

---

## Open Questions for Phase 6 Implementation

| # | Question | Proposed Resolution |
|---|----------|-------------------|
| 1 | Should replica reads use `read_replica` endpoint or separate connection string? | Use Neon's `--replica` connection string for explicit routing |
| 2 | How to handle replica promotion during primary failover? | Neon automatic failover + DNS/config hot-reload via platform |
| 3 | Should event append batching be supported for write-heavy tenants? | Defer to Phase 6.3; measure primary throughput first |
| 4 | How to implement regional health checks? | `/api/health` endpoint + Cloudflare health check monitors |
| 5 | Should tenant affinity be in `TenantConfig` or a separate routing table? | `TenantConfig` initially; extract if routing table grows |
