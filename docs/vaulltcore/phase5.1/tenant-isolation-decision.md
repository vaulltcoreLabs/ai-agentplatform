# Phase 5.1 — Tenant Isolation Decision (§19)

**Date:** 2026-08-26
**Git SHA:** d4bbc12721b6c6b6a5a9a794a7adea8bc9069dbc

---

## Decision: OPTION A — Application-level isolation only (no RLS)

---

## 1. Current Isolation Architecture

Tenant isolation is enforced at **three layers**:

### Layer 1: WorkflowStore key prefixing

All WorkflowStore operations prefix keys with `${tenantId}::`:

```typescript
function tenantKey(tenantId: string, key: string): string {
  return `t${TENANT_SEP}${tenantId}${TENANT_SEP}${key}`;
}
```

- `getJob(TENANT_A, jobId)` reads key `t::TENANT_A::job::${jobId}`
- `getJob(TENANT_B, jobId)` reads key `t::TENANT_B::job::${jobId}`
- Cross-tenant reads return `undefined` — keys don't exist in the other tenant's namespace

### Layer 2: Runtime authorization

Every `DistributedDurableRuntime` operation calls:

```typescript
assertAuthorized(tenantId, tenantIds);  // rejects unknown tenants
assertTenantKnown(tenantId, tenantIds); // rejects rogue tenants
```

- Unknown tenants are rejected at the API boundary
- Cancel operations verify job belongs to the requesting tenant

### Layer 3: Queue composite identity

Queue messages use `(tenantId, messageId)` composite keys:
- `qmeta::${tenantId}::${messageId}`
- Cross-tenant message-ID collisions are structurally impossible

---

## 2. Evidence for Application-Level Isolation

| Experiment | Result | Evidence File |
|-----------|--------|---------------|
| B cannot read A's job via getJob | ✅ PASS | `adv-backend-cross-read.json` |
| B cannot cancel A's job | ✅ PASS | `adv-runtime-cross-ops.json` |
| 100 concurrent cross-tenant submits | ✅ ZERO contamination | `tenant-cross-contamination-100.json` |
| 1000 concurrent cross-tenant submits | ✅ ZERO contamination | `adv-1000-cross-contamination.json` |
| Same idempotency key across tenants | ✅ Independent state | `adv-idem-cross-tenant.json` |
| Same messageId across tenants | ✅ Composite key isolation | `adv-queue-id-collision.json` |
| Concurrent cross-tenant queue ops | ✅ No message leakage | `adv-concurrent-queue-ops.json` |
| Unknown tenant rejected | ✅ Throws | `tenant-boundary.test.ts` |

---

## 3. Why NOT RLS

**Arguments against RLS for v1:**

1. **SharedBackend is a KV abstraction** — the underlying storage is `vc_kv` with a single table. RLS would require either:
   - Migrating to a normalized schema (high risk, no architectural benefit)
   - Implementing RLS on the KV table (complex, fragile with JSONB keys)

2. **Isolation is already proven** at 3 layers — 57/57 experiments pass with zero cross-tenant contamination

3. **RLS adds operational complexity** — requires per-connection tenant context, connection pool management, and migration of all queries

4. **The SharedBackend abstraction is intentionally simple** — RLS would leak Postgres-specific concerns into the provider-neutral contract

5. **No demonstrated threat** — the application is single-tenant-isolated by construction; there is no multi-tenant attack surface at the storage layer

---

## 4. Threat Model

| Threat | Mitigation | Status |
|--------|-----------|--------|
| Rogue tenant submission | `assertAuthorized` at Runtime boundary | ✅ PROVEN |
| Cross-tenant job read | WorkflowStore key prefix | ✅ PROVEN |
| Cross-tenant cancel | Runtime authorization | ✅ PROVEN |
| Cross-tenant queue claim | Composite (tenantId, messageId) | ✅ STRUCTURALLY ENFORCED |
| Cross-tenant idempotency collision | Tenant-salted idempotency keys | ✅ PROVEN |
| Direct database access bypassing API | No direct DB access in production (API-only) | ACCEPTED |

---

## 5. Compensating Controls

1. **All durable state access goes through WorkflowStore** — no direct KV reads in production code paths
2. **Runtime authorization rejects unknown tenants** at every entry point
3. **Queue composite keys** prevent cross-tenant message contamination at the storage layer
4. **Idempotency keys are tenant-salted** — same key in different tenants creates independent state
5. **Regression tests** in `tenant-boundary.test.ts` and `tenant-adversarial-deep.test.ts` guard against isolation regressions

---

## 6. When RLS Would Be Warranted

RLS should be reconsidered if:

1. Vaulltcore becomes a multi-tenant SaaS serving external customers
2. Direct database access is permitted (bypassing the API)
3. A security audit requires defense-in-depth at the storage layer
4. The KV abstraction is replaced with a normalized relational schema

---

## 7. Prohibited Patterns

The following patterns are **prohibited** in production code:

- Direct `vc_kv` reads bypassing WorkflowStore
- Hardcoded tenant IDs in business logic
- Tenant-agnostic KV operations in API handlers
- Queue claims without tenant context
- Idempotency keys without tenant prefix

These prohibitions are enforced by the provider boundary test (§36) and the tenant adversarial tests (§20).

---

## 8. Regression Strategy

Tenant isolation regressions are caught by:

- `phase5/tenant-boundary.test.ts` — 8 tests
- `phase5/tenant-adversarial-deep.test.ts` — 6 tests
- `phase48/` conformance suite — tenant-gated operations
- `workflow/distributed.test.ts` — distributed tenant isolation

Any change to WorkflowStore, Queue, or Runtime must pass all tenant isolation tests.
