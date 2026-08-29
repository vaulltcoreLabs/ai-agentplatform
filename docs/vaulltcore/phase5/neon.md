# Phase 5 — Neon PostgreSQL Audit

**Runtime driver (apps/web/lib/db/client.ts):** `@neondatabase/serverless` `Pool`
(WebSocket) + `drizzle-orm/neon-serverless`.

**Why Pool (not `neon()` HTTP):**
- The runtime path uses interactive transactions (`db.transaction(...)`) in
  `lib/db/sessions.ts` and `lib/db/workflow-runs.ts`.
- `neon()` HTTP driver does NOT support multi-statement interactive transactions;
  the WebSocket `Pool` does. The ACTUAL repo uses the WebSocket Pool, which is
  the semantically correct choice for these paths. This was verified, NOT blindly reverted.
- The WebSocket Pool multiplexes over a single WebSocket; it does not require a
  long-lived TCP pool in the same way `postgres-js` does.

**Migration/admin path (apps/web/lib/db/migrate.ts):** `postgres` + `drizzle-orm/postgres-js/migrator`.
- Intentional separation: migrations are admin-only and never run on the request path.
- No second runtime client is introduced. `POSTGRES_URL` remains the single connection variable.

**Neon transaction semantics audit (per §5):**
- `db.transaction(async (tx) => {...})` — interactive, supported by neon-serverless Pool.
- The durability substrate (`PostgresSharedBackend` in `packages/adapters/pg-backend.ts`)
  uses the `postgres` client directly for Phase 4.6/4.8 conformance and is a SEPARATE
  adapter from the web runtime client. Phase 4.8 invariants (CAS/appendUnique/fencing)
  live there and are unaffected by the runtime driver choice.
- Each mutator in `pg-backend.ts` is a SINGLE atomic SQL statement (ON CONFLICT DO
  NOTHING / UPDATE ... WHERE value IS NOT DISTINCT FROM). No SELECT→compute→UPDATE
  sequences exist, so retry cannot duplicate a side effect at the storage layer.

**SSL/TLS:** Neon requires TLS on its connection string (`sslmode=require` embedded in
`POSTGRES_URL`). No plaintext path.

**Error classification / retry (§3 J, §6):** The durable substrate relies on atomic
single-statement operations; idempotency is enforced by the database (ON CONFLICT /
CAS), so a retried write is safe. There is NO generic `catch => retry` that could
duplicate a side effect. The artifact service escalates duplicate-confirmation to a
no-op (idempotent), not a re-write.

**Real Neon connection gate:** `packages/adapters/phase5/neon-real-gate.test.ts`.
- Activated by `VAULLTCORE_TEST_POSTGRES_URL` (or `POSTGRES_URL`).
- Runs migration, CRUD, CAS, append, appendUnique, incr, queue, leases, fencing,
  idempotent submit, cross-tenant isolation, restart/reconnect, concurrent writes.
- Without the URL: SKIPPED — missing infrastructure (never counted as PASS).

**Real Neon execution (2026-08-27, us-east-2 pooler endpoint):** migrations + CRUD +
single-op CAS/incr PASS reliably; 50-way concurrent conformance CONDITIONED on the
pooler (see evidence). Single/low-concurrency substrate SQL PROVEN on real Neon and on
local PostgreSQL (Phases 4.6–4.8).

**Status:**

| Item | State |
|------|-------|
| Runtime driver correctness | IMPLEMENTED + REVIEWED |
| Migration/admin separation | IMPLEMENTED |
| Transaction semantics | IMPLEMENTED (Pool supports interactive tx) |
| Real Neon — migrations/CRUD/single-op CAS/incr | **PROVEN** (executed 2026-08-27) |
| Real Neon — high-concurrency conformance on pooler endpoint | **CONDITIONED** |
| Real Neon — connection latency/RTT benchmarks | **BLOCKED** (no direct-endpoint access) |

**Mitigation for the CONDITIONED case:** use the Neon **direct** (non-pooler) endpoint,
or PgBouncer in transaction mode, or pin all durable control-plane reads/writes to a
single primary connection so read-after-write consistency holds under concurrency.
