# Phase 6 — Implementation Plan

## Overview

This plan defines the concrete code changes, new files, and verification steps
to bring multi-region capability to Vaulltcore. It follows the architecture in
`docs/vaulltcore/phase6/architecture.md` and builds on the existing adapter
pattern without modifying core contracts.

**Principle**: every change is behind a configuration switch. Single-region
deployments are unaffected. The `RegionalSharedBackend` is opt-in.

---

## Phase 6.1: Regional Read Replica Adapter

**Goal**: Workers in a secondary region read from a local Neon replica while
writing to the primary. Zero contract changes.

### New Files

```
packages/adapters/regional-pg-backend.ts     — RegionalSharedBackend adapter
packages/adapters/regional-pg-backend.test.ts — Unit tests
packages/adapters/phase6/regional-routing.test.ts — Integration tests
```

### Implementation: `RegionalSharedBackend`

```typescript
// packages/adapters/regional-pg-backend.ts

import { PostgresSharedBackend } from "./pg-backend";
import type { SharedBackend, CasValue } from "@vaulltcore/workflow";
import { CAS_ABSENT } from "@vaulltcore/workflow";

export interface RegionalBackendConfig {
  /** Connection string for the Neon primary (writes). */
  readonly primaryUrl: string;
  /** Connection string for the regional Neon read replica (reads). */
  readonly replicaUrl: string;
  /** Optional: pool size for each connection. */
  readonly poolSize?: number;
  /** Optional: connection timeout (ms). */
  readonly connectTimeoutMs?: number;
}

/**
 * Multi-region SharedBackend that routes:
 *   CAS / append / incr / del / appendUnique → primary (linearizable)
 *   get / list / keys → replica (eventual consistency)
 *
 * All other SharedBackend methods are pure compositions of the above.
 */
export class RegionalSharedBackend implements SharedBackend {
  private readonly primary: PostgresSharedBackend;
  private readonly replica: PostgresSharedBackend;

  constructor(config: RegionalBackendConfig) {
    this.primary = PostgresSharedBackend.fromConnectionString(
      config.primaryUrl,
    );
    this.replica = PostgresSharedBackend.fromConnectionString(
      config.replicaUrl,
    );
  }

  // --- Writes → primary ---

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

  async appendUnique?(
    key: string,
    dedupKey: string,
    value: unknown,
  ): Promise<{ appended: boolean; existing?: unknown }> {
    return this.primary.appendUnique!(key, dedupKey, value);
  }

  // --- Reads → replica ---

  async get(key: string): Promise<unknown> {
    return this.replica.get(key);
  }

  async list(key: string): Promise<unknown[]> {
    return this.replica.list(key);
  }

  async keys(prefix: string): Promise<string[]> {
    return this.replica.keys(prefix);
  }

  // --- Lifecycle ---

  async close(): Promise<void> {
    await Promise.all([
      (this.primary as unknown as { close?: () => Promise<void> }).close?.(),
      (this.replica as unknown as { close?: () => Promise<void> }).close?.(),
    ]);
  }
}
```

### New Tests

```
packages/adapters/regional-pg-backend.test.ts
```

| Test | Description |
|------|-------------|
| CAS routes to primary | Write via `RegionalSharedBackend`, verify visible on primary AND replica (after lag) |
| Read from replica | Write to primary, read from `RegionalSharedBackend` → reads replica |
| Replica lag bounded | Write to primary, immediate read from replica → may return stale; after 500ms → returns current |
| Primary unreachable | Simulate primary connection failure → CAS fails, reads still work |
| Replica unreachable | Simulate replica connection failure → writes still work, reads fail |
| appendUnique on primary | Verify dedup marker is atomic on primary (no split-brain) |
| Key partitioning preserved | Verify tenant-prefixed keys work identically to single-region backend |

### Configuration

The adapter is activated via environment variables:

```bash
# Primary (required for multi-region)
NEON_PRIMARY_URL=postgres://...@ep-xxx.us-east-1.aws.neon.tech/dbname

# Regional replica (optional; omit for single-region)
NEON_REPLICA_URL=postgres://...@ep-yyy.eu-west-1.aws.neon.tech/dbname
```

When `NEON_REPLICA_URL` is set, the system uses `RegionalSharedBackend`.
When omitted, the system uses `PostgresSharedBackend` directly (existing
behavior, zero regression).

### Composition Root Update

```typescript
// packages/adapters/index.ts (addition)

export function createSharedBackend(config?: {
  primaryUrl?: string;
  replicaUrl?: string;
}): SharedBackend {
  if (config?.replicaUrl) {
    return new RegionalSharedBackend({
      primaryUrl: config.primaryUrl!,
      replicaUrl: config.replicaUrl,
    });
  }
  if (config?.primaryUrl) {
    return PostgresSharedBackend.fromConnectionString(config.primaryUrl);
  }
  return new MemorySharedBackend();
}
```

---

## Phase 6.2: Health Checks & Regional Awareness

**Goal**: Expose health status so Cloudflare (or any load balancer) can route
traffic to the healthy region.

### New Files

```
packages/workflow/health.ts           — Health check contract
packages/adapters/health-pg.ts        — Postgres health check implementation
packages/adapters/health-regional.ts   — Multi-region health check
apps/web/app/api/health/route.ts      — API endpoint
```

### Health Check Contract

```typescript
// packages/workflow/health.ts

export interface RegionalHealth {
  readonly regionId: string;
  readonly primaryReachable: boolean;
  readonly replicaReachable: boolean;
  readonly replicaLagMs: number | null;
  readonly queueDepth: number;
  readonly activeRunCount: number;
  readonly timestamp: number;
  readonly healthy: boolean;
}

export interface HealthChecker {
  check(): Promise<RegionalHealth>;
}
```

### API Endpoint

```typescript
// apps/web/app/api/health/route.ts

import { NextResponse } from "next/server";

export async function GET() {
  const health = await healthChecker.check();
  return NextResponse.json(health, {
    status: health.healthy ? 200 : 503,
  });
}
```

### Cloudflare Configuration

```yaml
# cloudflare-health-check.yml
health_checks:
  - name: vaulltcore-us
    endpoint: https://us.example.com/api/health
    interval: 10s
    timeout: 5s
    expected_status: 200
  - name: vaulltcore-eu
    endpoint: https://eu.example.com/api/health
    interval: 10s
    timeout: 5s
    expected_status: 200
```

---

## Phase 6.3: Regional Queue Partitioning (Future)

**Goal**: Reduce cross-region CAS latency for queue operations by
partitioning queue messages by tenant affinity.

This phase is deferred until:
- Tenant count > 1000, OR
- Queue claim p99 from secondary region > 200ms, OR
- Benchmarks show queue CAS as a bottleneck

### Design Sketch

```
Region A (US):
  qvisible::us-east    — messages for US-pinned tenants
  qmeta::us-east::*    — metadata for US-pinned tenants

Region B (EU):
  qvisible::eu-west    — messages for EU-pinned tenants
  qmeta::eu-west::*    — metadata for EU-pinned tenants

Global (primary):
  qvisible::global     — unpinned tenants (default)
  qmeta::global::*     — unpinned metadata
```

Workers in each region claim from their regional partition first, then fall
back to the global partition. A global reconciler periodically moves stale
messages from one region's partition to another.

**Key change**: `DistributedQueue` gains a `regionId` parameter. The
`RegionalSharedBackend` is extended with a `regionalKeys()` method that
scopes `keys()` to a region prefix.

---

## Phase 6.4: Primary Failover Hardening

**Goal**: Verify and harden the system against Neon primary failure under
load.

### Chaos Tests

```
packages/adapters/phase6/chaos/
  primary-failover.test.ts         — Kill primary during active work
  replica-promotion.test.ts        — Simulate Neon failover
  network-partition.test.ts        — Isolate region from primary
  region-loss.test.ts              — Simulate complete region loss
```

### Failover Procedure

1. **Detection**: health check fails for 3 consecutive intervals (30s).
2. **DNS update**: Cloudflare health check marks region unhealthy → traffic
   reroutes to surviving region.
3. **Neon failover**: Neon promotes read replica to primary (automatic).
4. **Worker recovery**: workers in surviving region reconnect to new primary.
   In-flight steps complete or expire via lease TTL.
5. **Reconciliation**: surviving workers reconcile all active runs, re-enqueuing
   any that lost their queue message.

### Verification Criteria

| Property | Target | How Verified |
|----------|--------|--------------|
| RPO | 0 | Neon sync replication; no committed writes lost |
| RTO | <30s | Health check interval (10s) + Neon failover (~20s) |
| In-flight steps | Restart from checkpoint | Lease expiry → new worker → checkpoint resume |
| Queue messages | Reconciled within 60s | Periodic reconcile + idempotent re-enqueue |
| Event ordering | Preserved | Sequence allocated at primary; post-failover events continue monotonically |

---

## Implementation Order

| Step | Phase | Files Changed | Dependencies |
|------|-------|--------------|-------------|
| 1 | 6.1 | `packages/adapters/regional-pg-backend.ts` (new) | Neon read replica provisioned |
| 2 | 6.1 | `packages/adapters/regional-pg-backend.test.ts` (new) | Step 1 |
| 3 | 6.1 | `packages/adapters/index.ts` (update) | Step 1 |
| 4 | 6.1 | `packages/adapters/phase6/regional-routing.test.ts` (new) | Steps 1-3 |
| 5 | 6.2 | `packages/workflow/health.ts` (new) | None |
| 6 | 6.2 | `packages/adapters/health-pg.ts` (new) | Step 5 |
| 7 | 6.2 | `apps/web/app/api/health/route.ts` (new) | Step 6 |
| 8 | 6.2 | `packages/adapters/health-regional.ts` (new) | Steps 5-7 |
| 9 | 6.4 | `packages/adapters/phase6/chaos/` (new) | Steps 1-8 |
| 10 | — | `docs/vaulltcore/VAULLTCORE-MASTER-REPORT.md` (update) | Steps 1-9 |

### Estimated Effort

| Phase | Scope | Estimated LOC |
|-------|-------|--------------|
| 6.1 | RegionalSharedBackend + tests | ~300 |
| 6.2 | Health checks + API endpoint | ~200 |
| 6.3 | Regional queue partitioning (deferred) | ~500 |
| 6.4 | Chaos tests + failover hardening | ~400 |
| **Total** | | **~1400** |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Neon replica lag exceeds bounds | Low | Medium | Health check flags degraded region; Cloudflare routes away |
| Primary failover loses in-flight CAS | Very Low | High | Neon sync replication; lease TTL forces restart from checkpoint |
| Cross-region CAS latency degrades throughput | Medium | Low | Phase 6.3 queue partitioning eliminates cross-region CAS for most paths |
| RegionalSharedBackend introduces regression | Low | High | Full conformance suite runs against both primary-only and regional adapters |

---

## Phase 6 Authorization

Phase 6.1 is authorized to begin immediately after Phase 5.1 closure. The
architecture is validated by:

1. **Structural safety**: `RegionalSharedBackend` implements the same
   `SharedBackend` contract; all existing stores, runtime, and worker code
   is unchanged.
2. **Consistency preservation**: all correctness-critical operations
   (CAS, lease, idempotency) route to primary with identical guarantees.
3. **Graceful degradation**: replica reads are eventually consistent with
   bounded lag; every read path already handles stale data via retry.
4. **No contract changes**: the adapter swap is invisible to the workflow,
   agent, intelligence, and sandbox packages.
