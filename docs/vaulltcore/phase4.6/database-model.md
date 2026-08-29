# Phase 4.6 — Database Model

## Schema rationale (smallest correct design)

The workflow domain already partitions jobs/runs/tasks/steps/leases/events/
checkpoints/cancellation into **tenant-prefixed durable keys**
(`packages/workflow/distributed-store.ts` `tenantKey()`), and expresses every
guarantee through four primitive operations on those keys
(atomic CAS, atomic append, atomic incr, delete). The smallest schema that
preserves this identity model exactly — rather than deriving a second parallel
relational one — is therefore a per-key row store:

```sql
vc_kv (
  key     TEXT PRIMARY KEY,          -- tenant-scoped by construction
  kind    TEXT CHECK (kind IN ('scalar','list','counter')),
  value   JSONB,                     -- opaque durable documents
  counter BIGINT,
  CHECK (counter-payload consistency)
)
CREATE INDEX vc_kv_key_prefix_idx ON vc_kv (key text_pattern_ops);
```

**Why JSONB:** every `SharedBackend` value is an opaque document; JSONB also
gives CAS structural deep-equality (`value IS NOT DISTINCT FROM $expected`)
natively — identical semantics across SQLite (JSON round-trip + deepEqual) and
Memory (casValueEqual). Verified identical by the conformance suite.

**Index tradeoff:** exactly ONE prefix index. All access paths are exact-key or
prefix-scan; extra indexes would tax writes for zero read benefit.

## Transaction boundaries

| Operation | SQL shape | Isolation | Contention |
| --- | --- | --- | --- |
| `cas` absent | single `INSERT … ON CONFLICT DO NOTHING` | row lock on conflict | key-level |
| `cas` matched | single `UPDATE … WHERE value = $expected` | row lock | key-level |
| `append` | single upsert with `value \|\| EXCLUDED.value` | row lock | stream-key-level |
| `incr` | single upsert `RETURNING counter` | row lock | counter-key-level |
| `del` / `get` / `list` / `keys` | single statements | MVCC read | none |

- No operation spans more than one statement; no SELECT→compute→UPDATE exists.
- **The adapter never holds a transaction while agent/sandbox/model work
  executes.** The database coordinates durable state only.
- Event sequence allocation uses `incr` (unique values proven under 50-way
  concurrency in conformance tests).

## Tenant isolation

Tenant scoping lives in the KEY namespace (`t::<tenant>::<resource>`), which
is part of the primary key itself. A cross-tenant read requires knowing and
using another tenant's key; the stores' tenant-partitioned lookups make this
unreachable from their public APIs (Phase 4.1 F-10 authorization gate remains
the caller-side check). The conformance suite's `keys(prefix)` test verifies
prefix scans never leak across namespaces.

## Migrations & failure classification

- Versioned, forward-only migrations tracked in `vc_schema_migrations`;
  applied idempotently by `migratePostgres()`; never destructive at runtime.
  Rollback strategy: restore-from-backup + re-run.
- Error classes: transient (SQLITE_BUSY, PG 40001/40P01/57P03/53300,
  ECONNREFUSED/RESET/TIMEDOUT) → bounded jittered retry; permanent
  (constraint violations, unknowns) → propagate immediately. Constraint
  violations are permanent *for retry purposes* because their meaning ("already
  done") belongs to the idempotency layer, not to blind retries.
