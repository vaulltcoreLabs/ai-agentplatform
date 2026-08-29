# Phase 5 — Real Infrastructure Wiring: Acceptance Report

**Date:** 2026-08-26
**Baseline SHA:** c3f0ca3d0ba18d1536d4fe13556c7d607669b59b
**Final SHA:** (see `git rev-parse HEAD` after commit)
**Branch:** session/agent_6396752e-2b71-476c-8a19-ab09693550d1

---

## A. Baseline SHA
c3f0ca3d0ba18d1536d4fe13556c7d607669b59b (see `docs/vaulltcore/phase5/baseline.md`).

## B. Changed Files
- `packages/storage/artifact.ts` — NEW provider-neutral `ArtifactService` + `ArtifactMetadataStore` contract + `InMemoryArtifactMetadataStore`.
- `packages/storage/artifact.test.ts` — NEW full lifecycle/idempotency/tenant/reconcile/failure/crash-window suite (16 tests, real code paths).
- `packages/storage/index.ts` — re-exports artifact module.
- `packages/storage/memory-object-store.ts` — added `failHeadOnce` hook (failure injection).
- `packages/storage/object-store.ts` — unchanged (contract already present).
- `packages/storage/r2/*` — unchanged (adapter already present from d4bbc12).
- `apps/web/lib/db/schema.ts` — NEW `artifacts` table.
- `apps/web/lib/db/migrations/0037_add_artifacts.sql` + journal entry — NEW migration.
- `apps/web/lib/db/artifacts.ts` — NEW `PostgresArtifactMetadataStore` (adapter boundary).
- `apps/web/lib/storage/server.ts` — NEW server wiring (`getArtifactService`).
- `apps/web/app/api/artifacts/reserve/route.ts` — NEW (presigned PUT).
- `apps/web/app/api/artifacts/confirm/route.ts` — NEW (confirm → READY).
- `apps/web/app/api/artifacts/download/[artifactId]/route.ts` — NEW (presigned GET).
- `apps/web/app/api/artifacts/[artifactId]/route.ts` — NEW (delete).
- `apps/web/lib/db/artifacts.real-gate.test.ts` — NEW real Neon+R2 gate (skips w/o infra).
- `apps/web/package.json` — added `@vaulltcore/storage` workspace dep.
- Docs: `baseline.md`, `storage-contract.md`, `neon.md`, `r2.md`, `infrastructure.md`, `deployment.md`, `failure-model.md`.
- Evidence: `artifact-idempotency.json`, `artifact-reconciliation.json`, `cross-tenant-storage.json` (+ existing R2/Neon gate status files).

## C. Dependency Changes
- `@vaulltcore/storage` added as workspace dependency of `apps/web` (no new registry deps).
- Storage package already depended on `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (from d4bbc12).

## D. Neon Architecture
- Runtime: `@neondatabase/serverless` WebSocket `Pool` + `drizzle-orm/neon-serverless` (`apps/web/lib/db/client.ts`). Supports interactive transactions.
- Admin/migration: `postgres` + `drizzle-orm/postgres-js/migrator` (`migrate.ts`). Separated intentionally.
- Durable substrate (`PostgresSharedBackend`) is a distinct adapter; Phase 4.8 invariants preserved.
- No second runtime client introduced. No generic retry that could duplicate writes.

## E. R2 Architecture
- `R2ObjectStore` (S3-compatible, Node/Bun/Fly) behind `ObjectStore`. Single file imports `@aws-sdk`.
- Tenant-scoped keys; Content-Type-bound presigned PUT; expiry clamped [30s,900s].

## F. Provider Boundaries
- Provider-neutral packages (`workflow`, `agent`, `intelligence`, `shared`, `storage/object-store.ts`, `storage/artifact.ts`, `adapters` contract) contain ZERO real imports of `@aws-sdk`, `@neondatabase`, `@cloudflare`, or drizzle provider drivers.
- `@aws-sdk` confined to `packages/storage/r2/r2-object-store.ts`.
- Neon/drizzle confined to `apps/web/lib/db/`.
- AUDIT RESULT: PASS (see §27 audit + grep evidence in baseline.md).

## G. Security Model
- Authorization for artifacts is in PostgreSQL metadata, keyed by (tenantId, runId, artifactId). A wrong-tenant request returns no row → no presigned URL.
- Object keys are server-constructed; clients cannot choose tenant/run/artifact path.
- Presigned URLs are bearer capabilities: short-lived, operation-specific, Content-Type-bound for PUT. Never logged in full.
- `MAX_ARTIFACT_BYTES = 256 MiB`. No credentials in logs/events.

## H. Tenant Isolation
- PROVEN at the metadata layer (16-test suite, `cross-tenant-storage.json`): two tenants with identical runId+artifactId get distinct keys; tenant-B cannot read/download/delete tenant-A's artifact because the metadata query is tenant-scoped and returns null.

## I. Artifact Lifecycle
- RESERVED → UPLOADING → READY → DELETING → DELETED, plus FAILED. Two-phase: Postgres metadata authoritative, R2 body authoritative for bytes. Reconciliation repairs divergence.

## J. Migration Safety
- `0037_add_artifacts.sql` is `CREATE TABLE IF NOT EXISTS` + idempotent index creation. Re-run safe. Journal entry added. (Execution against real Neon is BLOCKED here; gate skips.)

## K. Failure Injection
- PROVEN via unit suite against `MemoryObjectStore` failure hooks (`artifact-reconciliation.json`, failure-injection describe):
  - DB reservation OK, R2 upload fails → no READY (stays UPLOADING).
  - R2 HEAD fails during confirm → stays UPLOADING, no READY.
  - Confirm with missing object → FAILED (no dangling READY).
  - R2 delete fails → remains DELETING; reconcile retries + purges.

## L. Crash-Window Results
- PROVEN: confirm after a concurrent worker already moved state re-reads authoritative state (no duplicate READY); delete after another worker purged returns DELETED (idempotent). No "atomic across Neon+R2" claim — guarantee is convergence + idempotency + reconciliation.

## M. Idempotency Results
- PROVEN (`artifact-idempotency.json`): 31 reserve attempts + 11 confirms on the same (tenant,run,artifactId) → exactly ONE object key, ONE metadata row, lifecycle READY. Retries/worker crashes cannot create a second object.

## N. Reconciliation Results
- PROVEN (`artifact-reconciliation.json` + suite): all six divergence classes handled
  (A READY/missing-object→FAILED; B/E orphan object reported; C DELETING/object-remains→purged;
  D UPLOADING-stalled→FAILED; idempotent re-run). Never deletes unknown objects blindly.

## O. Real Neon Test Results
- **BLOCKED** — no `VAULLTCORE_TEST_POSTGRES_URL` / `POSTGRES_URL` in sandbox. `neon-real-gate.test.ts` SKIPPED (not PASS).

## P. Real R2 Test Results
- **BLOCKED** — no `R2_*` credentials. `r2-real-gate.test.ts` SKIPPED. The cross-provider
  `artifacts.real-gate.test.ts` also SKIPPED (requires both Neon + R2).

## Q. Benchmark Results
- **BLOCKED** — no managed Neon/R2 reachable; cannot measure p50/p95/p99 RTT/latency.
  Unit suite timings are local in-memory only and NOT representative of production.

## R. Network Results
- **BLOCKED** — region/provider/RTT not measurable from sandbox.

## S. Cost-Control Mechanisms
- `MAX_ARTIFACT_BYTES` (256 MiB), presign clamp [30s,900s], server-constructed keys,
  idempotent object keys (retries reuse key; no duplicate uploads), 30-min UPLOADING
  grace for reconciliation, no client-driven re-upload loops.

## T. Remaining Conditions
1. Real Neon end-to-end gate — BLOCKED (no Neon URL).
2. Real R2 end-to-end gate — BLOCKED (no R2 creds).
3. Cross-provider (Neon+R2) real gate — BLOCKED.
4. Neon transaction RTT / latency benchmarks — BLOCKED.
5. R2 latency/throughput benchmarks — BLOCKED.
6. Production deployment of artifact routes — CONDITIONED (wired, typechecked; not exercised without infra).

## U. Known Unknowns
- Actual Neon HTTP/WebSocket round-trip latency under load.
- Actual R2 PUT/GET p99 at scale.
- Behavior of presigned-URL theft in a real CDN/WAF path (mitigated by short expiry + server-side auth-before-URL).

## V. Production Restrictions
- R2 is object storage only; it is NEVER a source of truth for jobs/runs/leases/fencing/idempotency/queue/tenant auth/events.
- PostgreSQL (Neon) remains authoritative for all transactional control-plane state.
- Artifact routes require R2 config; without it they return 503 (no fake success).
- Migration `0037` must be applied to the Neon database before artifact routes are used (CI `db:migrate:apply`).

## W. Next Permitted Phase
- Phase 6 (deployment hardening / multi-region) is permitted ONLY after the BLOCKED real-infra gates (O–R) are executed against actual Neon + R2 and pass. The artifact control-plane code is complete and unit-proven; the remaining items are infrastructure-access gates, not code gaps.

---

## VERDICT

**PASS WITH CONDITIONS.**

Rationale:
- All provider-neutral correctness properties (idempotency, tenant isolation, reconciliation, failure injection, crash-window convergence, presign security, key isolation) are PROVEN via executable tests against real code paths.
- Provider boundaries are intact (audit PASS).
- Real Neon/R2 end-to-end execution is BLOCKED solely by absent infrastructure credentials in this sandbox; the gates are implemented and SKIP honestly (never faked as PASS).
- No critical invariant fails. No code regression introduced (adapters phase5: 34 pass; storage: 24 pass/0 fail + 4 skip; workflow: unchanged).

**Every BLOCKED item is an infrastructure-access gate, explicitly documented, not a hidden assumption.**
