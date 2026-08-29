# Phase 4.6 — Production Database Adapters & Durability Gate

**Status:** PASS WITH CONDITIONS — SQLite adapter fully conformance-proven;
Postgres adapter implemented and gated on a live server (CONTRACTUAL until
executed). See `acceptance-report.md`.

Phase 4.6 turns the Phase 4.5 `SharedBackend` contract into real production
database adapters **without changing workflow engine semantics**, and adds the
machinery that makes adapter claims verifiable:

## What landed

1. **Adapter conformance suite** (`packages/adapters/conformance.ts`) —
   `describeSharedBackendConformance(factory)` runs ONE semantic test-suite
   against every backend. Distributed sections run only when a factory can
   supply two INDEPENDENT connections over shared durable state.
2. **MemorySharedBackend semantic fix** — its CAS used object identity
   (`Object.is`); real backends compare values. Now uses structural equality,
   aligning the deterministic reference with production semantics. All 239
   existing workflow tests pass unchanged.
3. **`SqliteSharedBackend`** passes the full conformance suite with paired
   independent connections (CAS race → one winner; concurrent append
   completeness; unique sequence allocation).
4. **`PostgresSharedBackend`** (`pg-backend.ts`) — every mutator is a SINGLE
   parameterized SQL statement:
   - CAS-absent: `INSERT … ON CONFLICT DO NOTHING`
   - CAS-match: `UPDATE … WHERE value IS NOT DISTINCT FROM $expected::jsonb`
     (jsonb equality = structural deep equality)
   - append: `INSERT … ON CONFLICT DO UPDATE SET value = value || $chunk`
   - incr: `INSERT … ON CONFLICT DO UPDATE SET counter = counter +
     EXCLUDED.counter RETURNING counter`
   - Versioned idempotent migrations (`MIGRATIONS`, `migratePostgres()`),
     schema in `migrations/001_shared_backend.sql`.
5. **Database failure model** (`retry.ts`) — transient/permanent error
   classification (SQLite BUSY; PG 40001/40P01/57P03/53300; connection codes)
   and bounded jittered retry for transient classes only. Permanent errors
   propagate on attempt #1; unknown errors default permanent.
6. **Boundary hardening** — core packages now also reject `postgres`, `pg`,
   `kysely`, `drizzle-orm`, and `bun:sqlite` imports; persistence lives
   exclusively in packages/adapters.

## Identity cleanup

- `packages/agent/open-agent.ts` renamed to **`vaulltcore-agent.ts`**; all
  importers updated (0 remaining references).
- Vercel identity scrubbed from core/sandbox doc comments. The only remaining
  "vercel" strings are functional adapters (`packages/sandbox/vercel/`),
  control-plane OAuth configuration, ops scripts, and one skill-install
  example referencing the external GitHub source of an installed skill.

## Documents

| Doc | Content |
| --- | --- |
| `database-model.md` | Schema rationale, transaction boundaries, tenant isolation |
| `benchmark-report.md` | What was measured, what is CONTRACTUAL/FUTURE |
| `acceptance-report.md` | Full capability matrix with evidence |

Existing phase documents remain authoritative for their layers:
`../infrastructure/README.md` (planes), `../phase4.1/*` (distributed model),
`../phase4.3/security.md` (sandbox), `../phase4.5` coverage inside
`../infrastructure/acceptance-report.md`.
