# Phase 5 — Storage Contract (PostgreSQL × R2)

**Authoritative source of truth vs. object body.**

| Concern | PostgreSQL (Neon) | R2 |
|---------|-------------------|----|
| Job / run / lease / fencing state | ✅ authoritative | — |
| Idempotency keys | ✅ authoritative | — |
| Queue visibility | ✅ authoritative | — |
| Tenant authorization | ✅ authoritative | — |
| Event ordering / stream | ✅ authoritative | — |
| Artifact ownership & lifecycle | ✅ authoritative (`artifacts` table) | — |
| Artifact object body (bytes) | metadata reference only | ✅ authoritative body |
| Large blobs / logs / build outputs | — | ✅ |

**Rules (enforced in code, not prose):**
- `ObjectStore` (`packages/storage/object-store.ts`) is provider-neutral. No provider SDK import.
- `R2ObjectStore` (`packages/storage/r2/`) is the ONLY file importing `@aws-sdk/*`.
- `artifactObjectKey()` builds `tenants/{tenantId}/runs/{runId}/artifacts/{artifactId}`. All key segments are server-validated (no `/`, no `..`); clients never choose the path.
- `ArtifactService` (`packages/storage/artifact.ts`) orchestrates the two-phase lifecycle. It depends ONLY on `ArtifactMetadataStore` + `ObjectStore` interfaces.
- `PostgresArtifactMetadataStore` (`apps/web/lib/db/artifacts.ts`) is the Postgres impl (adapter boundary, may import drizzle/neon).
- There is NO distributed transaction across Postgres + R2. Convergence is achieved via the lifecycle state machine + `reconcile()`.

**Lifecycle states:** `RESERVED → UPLOADING → READY → (DELETING → DELETED)` with `FAILED` as a terminal error state.

**Upload flow:** authorize (tenant/run ownership in Postgres) → reserve metadata (RESERVED) → presigned PUT (UPLOADING, Content-Type-bound, ≤900s) → client uploads to R2 → server confirms (HEAD R2, validate, transition UPLOADING→READY with byteSize + sha256). If object missing at confirm → FAILED (never dangling READY).

**Download flow:** authorize → load metadata → require READY → presigned GET (≤900s). No URL for unknown/deleted/wrong-tenant.

**Delete flow:** READY/UPLOADING/FAILED → DELETING → delete object → purge metadata. Idempotent. R2 delete failure leaves DELETING; reconciliation retries.

**Cost control:** `MAX_ARTIFACT_BYTES = 256 MiB`; presign clamp `[30s, 900s]`; no client-chosen keys; idempotent object keys (retry reuses same key); reconciliation removes stalled UPLOADING after a 30-min grace.
