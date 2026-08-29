-- Phase 4.6 — Vaulltcore SharedBackend schema for Postgres (migration 001).
--
-- One table implements the entire SharedBackend contract. The existing domain
-- model already partitions jobs/runs/steps/events/checkpoints/leases into
-- tenant-prefixed KEYS (see packages/workflow/distributed-store.ts), so a
-- per-key row store is the smallest correct schema: it preserves the
-- Phase 4.1 identity model exactly instead of re-deriving a second,
-- parallel relational one.
--
-- JSONB is used because every value in the contract is an opaque durable
-- document. It also gives CAS its deep-equality semantics for free:
-- `value = $expected::jsonb` is structural equality in Postgres, matching
-- SqliteSharedBackend and MemorySharedBackend exactly.
--
-- Index tradeoff: ONE trigram-free prefix index on key. Every access path in
-- the stores is either exact-key or prefix-scan (keys(prefix)); no range or
-- full-text queries exist, so additional indexes would only tax writes.

CREATE TABLE IF NOT EXISTS vc_kv (
  key     TEXT PRIMARY KEY,
  kind    TEXT NOT NULL CHECK (kind IN ('scalar', 'list', 'counter')),
  value   JSONB,
  counter BIGINT,
  CONSTRAINT kind_payload CHECK (
    (kind = 'counter'  AND counter IS NOT NULL AND value IS NULL) OR
    (kind <> 'counter' AND counter IS NULL)
  )
);

-- Prefix scans (SharedBackend.keys) without a full-table sort.
CREATE INDEX IF NOT EXISTS vc_kv_key_prefix_idx ON vc_kv (key text_pattern_ops);

-- Version tracking: idempotent, forward-only migrations applied by
-- migratePostgres(). Rollback strategy: restore-from-backup + re-run; no
-- destructive statements exist in any shipped migration.
CREATE TABLE IF NOT EXISTS vc_schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
