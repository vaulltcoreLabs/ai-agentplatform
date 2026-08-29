# Phase 5 — Infrastructure & Environment Matrix

## Topology
```
INTERNET
   │
   ├─ Cloudflare (DNS/WAF/CDN, optional Workers)
   │
   ├─ Fly.io / Node / Bun  ── runtime workers, API routes, reconciler
   │        │
   │        ├─ R2  (object bodies, opaque bytes)
   │        └─ Neon PostgreSQL (authoritative control plane)
```

## Environment Matrix (§28)

| Env | Neon | R2 | What runs |
|-----|------|----|-----------|
| LOCAL | local PG or test PG (postgres URL) | Memory-only (test) | provider-neutral + unit tests |
| CI | optional (VAULLTCORE_TEST_POSTGRES_URL) | optional (R2_*) | provider-neutral always; real gates skip if absent |
| STAGING | real Neon | real R2 | full real gates + routes |
| PRODUCTION | real Neon | real R2 | secrets via platform secret manager |

## Tests → required env
- `packages/storage/artifact.test.ts` — none (Memory store). Always runs.
- `packages/storage/object-store.test.ts` — none. Always runs.
- `packages/storage/r2-real-gate.test.ts` — `R2_*`. Skips without.
- `packages/adapters/phase5/neon-real-gate.test.ts` — `VAULLTCORE_TEST_POSTGRES_URL`/`POSTGRES_URL`. Skips without.
- `apps/web/lib/db/artifacts.real-gate.test.ts` — both Neon + R2. Skips without.

## Secret management (§29)
- No secrets committed. `.env.example` contains variable names only.
- `R2_SECRET_ACCESS_KEY`, `POSTGRES_URL` never logged; presigned URLs never persisted in full.
- Run `grep -rniE 'secretAccessKey|POSTGRES_URL|R2_SECRET' docs/vaulltcore .env*` — only in safe context (config key names, not values).

## CI behavior (§42)
Default CI runs provider-neutral tests. Real-infra tests SKIP explicitly and are labeled
`SKIPPED — missing infrastructure`. A skip is never converted to PASS.
