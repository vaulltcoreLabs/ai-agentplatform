# Phase 5 — Deployment

## Prerequisites (production)
1. Apply migration `0037_add_artifacts.sql` to Neon. CI runs `apps/web` `db:migrate:apply`
   (which executes `lib/db/migrate.ts` over `POSTGRES_URL`). Idempotent.
2. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` in the
   platform secret manager. Routes return 503 if absent (no fake success).
3. `POSTGRES_URL` must point at Neon (TLS required).

## Routes (all require authentication + run ownership)
- `POST /api/artifacts/reserve` — `{runId, artifactId, contentType}` → presigned PUT.
- `POST /api/artifacts/confirm` — `{runId, artifactId, sha256?}` → READY (HEADS R2).
- `GET /api/artifacts/download/[artifactId]?runId=` → presigned GET.
- `DELETE /api/artifacts/[artifactId]?runId=` → DELETING → purge.

## Rollout safety
- Migration is additive (`CREATE TABLE IF NOT EXISTS`). Safe to apply before route deploy.
- No destructive migration. No schema break for existing tables.
- Artifact feature is additive; existing durability substrate untouched.

## Runtime topology
- Neon WebSocket Pool is created lazily on first `db` access (proxy init).
- R2 client is created once per process via `R2ObjectStore.fromEnv()`.
- `getArtifactService()` memoizes the `ArtifactService` per process.

## Coordinated transition
No schema/contract break between old and new workers. New migration + new routes can roll
out together; old workers simply lack the routes (no conflict).
