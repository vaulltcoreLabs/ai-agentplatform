# Phase 5 — Real Infrastructure Wiring: Forensic Baseline

**Date:** 2026-08-26
**Git SHA (HEAD):** c3f0ca3d0ba18d1536d4fe13556c7d607669b59b
**Branch:** session/agent_6396752e-2b71-476c-8a19-ab09693550d1

---

## 1. Repository State

- Working tree: clean at baseline (prior to this phase's edits).
- Package manager: pnpm (workspace) with `bun` for tests. `bun install` resolves `@vaulltcore/*` workspace links.
- No managed Neon PostgreSQL URL present (`VAULLTCORE_TEST_POSTGRES_URL` / `POSTGRES_URL` both unset).
- No R2 credentials present (`R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` all unset).

## 2. Phase 4.6–4.8 Evidence Preserved

- `packages/workflow/distributed-store.ts` — `SharedBackend` contract (CAS/append/appendUnique/incr/del/keys), unchanged.
- `packages/adapters/pg-backend.ts` — `PostgresSharedBackend` over the `postgres` client (durable substrate adapter, separate from web runtime client).
- Durability/crash/tenant/fencing evidence in `docs/vaulltcore/phase4.6..phase5.1/`.

## 3. Neon Audit (apps/web/lib/db/client.ts)

- Current `client.ts` uses `@neondatabase/serverless` `Pool` (WebSocket) + `drizzle-orm/neon-serverless`. This supports interactive transactions (`db.transaction`), required by `lib/db/sessions.ts` and `lib/db/workflow-runs.ts`.
- NOTE: The task brief describes a `neon()` HTTP switch (`drizzle-orm/neon-http`). The ACTUAL repo uses the WebSocket `Pool`, which is the semantically correct choice for transactional runtime paths. The WebSocket pool does NOT require a long-lived TCP pool in the same way postgres-js does; it multiplexes over a WebSocket. This is retained and NOT reverted.
- `migrate.ts` still uses `postgres` + `drizzle-orm/postgres-js/migrator` (admin path). This separation is intentional and correct: migrations are admin-only, runtime uses Neon. No second runtime client introduced.
- `POSTGRES_URL` remains the connection variable. It is read lazily; never logged.
- Transaction semantics: `db.transaction(async (tx) => {...})` — interactive transactions supported by neon-serverless Pool. Phase 4.8 invariants (CAS/appendUnique/fencing) live in the durability substrate (`pg-backend.ts`), NOT in the web runtime path, so they are unaffected by the runtime driver choice.

## 4. R2 Audit (packages/storage)

Already implemented in commit d4bbc12 (NOT modified except extended here):
- `packages/storage/object-store.ts` — PROVIDER-NEUTRAL `ObjectStore` contract, `artifactObjectKey()` tenant-scoped key construction, `MAX_ARTIFACT_BYTES`, presign expiry clamps.
- `packages/storage/r2/r2-object-store.ts` — ONLY file importing `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`. S3-compatible API for Node/Bun/Fly. Content-Type bound into PUT signature. Credentials from env, never logged.
- `packages/storage/r2/config.ts` — `readR2Config`/`hasR2Config`, reads `R2_*` keys only.
- `packages/storage/memory-object-store.ts` — TEST-ONLY store with injectable failure hooks.
- `packages/storage/r2-real-gate.test.ts` — real R2 gate, SKIPS without credentials.

## 5. Gap Analysis (what this phase adds)

| Gap | Disposition |
|-----|-------------|
| Artifact metadata schema in PostgreSQL | ADDED (`artifacts` table + migration) |
| Two-phase artifact lifecycle (RESERVED/UPLOADING/READY/FAILED/DELETING/DELETED) | ADDED (`packages/storage/artifact.ts`, provider-neutral) |
| Provider-neutral `ArtifactMetadataStore` interface + memory + Postgres impl | ADDED |
| `ArtifactService` orchestration (reserve → presign → confirm → READY; delete; reconcile) | ADDED |
| Idempotent artifact identity across Neon+R2 failure | PROVEN via tests (memory-backed) |
| Cross-tenant R2 adversarial tests | PROVEN via tests (memory-backed) |
| Reconciliation (6 divergence classes) | PROVEN via tests (memory-backed) |
| Upload/download/delete API routes | ADDED (env-gated; not runtime-testable here) |
| Real Neon/R2 end-to-end | BLOCKED (no infra) — gates SKIP honestly |

## 6. Provider-Boundary Reality

- Provider-neutral packages (`workflow`, `agent`, `intelligence`, `shared`, `storage` contract, `adapters` contract) contain NO `@neondatabase`, `@cloudflare`, `@aws-sdk` imports.
- `@aws-sdk/*` confined to `packages/storage/r2/` (adapter boundary) — verified.
- Neon/drizzle confined to `apps/web/lib/db/` (adapter boundary) — verified.

## 7. Infra Reality (honesty gate)

No managed Neon DB and no R2 bucket are reachable from this sandbox. Therefore:
- Real Neon gate (`neon-real-gate.test.ts`) SKIPS.
- Real R2 gate (`r2-real-gate.test.ts`) SKIPS.
- All artifact correctness/idempotency/tenant/reconciliation logic is PROVEN against the in-memory ObjectStore + in-memory metadata store (no mocks of provider behavior — real code paths, real failure hooks).
- Production Postgres + R2 wiring is implemented and typechecked, but end-to-end execution is BLOCKED and documented as such. No fabricated success.
