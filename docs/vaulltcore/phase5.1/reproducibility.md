# Phase 5.1 — Reproducibility Instructions

**Git SHA:** d4bbc12721b6c6b6a5a9a794a7adea8bc9069dbc
**Runtime:** Bun 1.3.14

---

## Prerequisites

```bash
# Clone the repository
git clone <repo-url> && cd vaulltcore

# Checkout exact SHA
git checkout d4bbc12721b6c6b6a5a9a794a7adea8bc9069dbc

# Install dependencies (bun workspace install resolves @vaulltcore/* workspace links)
bun install

# For PostgreSQL-gated tests (Phase 5 §1-§6, §9):
# Set VAULLTCORE_TEST_POSTGRES_URL to a PostgreSQL 14+ instance
export VAULLTCORE_TEST_POSTGRES_URL="postgres://user:pass@host:5432/dbname"
```

---

## Phase 5.1 Tests (No External Infrastructure)

All Phase 5.1 tests run on in-memory stores — no PostgreSQL required.

```bash
# Run all Phase 5.1 tests
cd packages/adapters
bun test phase5/reconciliation-stress.test.ts
bun test phase5/retry-amplification.test.ts
bun test phase5/credential-scan.test.ts
bun test phase5/provider-boundary.test.ts
bun test phase5/fencing-stress.test.ts
bun test phase5/event-integrity.test.ts
bun test phase5/tenant-adversarial-deep.test.ts
bun test phase5/crash-matrix.test.ts

# Run all at once
bun test phase5/reconciliation-stress.test.ts phase5/retry-amplification.test.ts phase5/credential-scan.test.ts phase5/provider-boundary.test.ts phase5/fencing-stress.test.ts phase5/event-integrity.test.ts phase5/tenant-adversarial-deep.test.ts phase5/crash-matrix.test.ts
```

**Expected result:** 33 tests, 33 pass, 0 fail

---

## Phase 5 Tests (Requires PostgreSQL)

```bash
# Start local PostgreSQL
sudo pg_ctlcluster 14 main start

# Create test user
sudo -u postgres psql -c "CREATE USER daytona WITH PASSWORD 'test';"
sudo -u postgres psql -c "GRANT ALL ON DATABASE postgres TO daytona;"

# Run Phase 5 tests
cd packages/adapters
export VAULLTCORE_TEST_POSTGRES_URL="postgres://daytona:test@127.0.0.1:5432/postgres"

bun test phase5/arch-freeze.test.ts
bun test phase5/process-crash.test.ts
bun test phase5/pg-failure.test.ts
bun test phase5/capacity.test.ts
bun test phase5/tenant-boundary.test.ts
bun test phase5/observability.test.ts
```

**Expected result (with PostgreSQL available):** 37 tests, 37 pass, 0 fail.
NOTE: Without `VAULLTCORE_TEST_POSTGRES_URL` these Phase 5 tests `describe.skip` and are
reported as BLOCKED in this environment — not as pass. They require a live PostgreSQL 14+
instance to execute.

---

## Full Regression Gate (All Packages)

```bash
# Typecheck all packages (run sequentially to avoid OOM)
cd packages/adapters && pnpm typecheck
cd packages/workflow && pnpm typecheck
cd packages/shared && pnpm typecheck
cd packages/intelligence && pnpm typecheck
cd packages/sandbox && pnpm typecheck
cd packages/agent && pnpm typecheck
cd apps/api && pnpm typecheck
cd apps/web && pnpm typecheck

# Run all adapter tests
cd packages/adapters
bun test phase5/

# Run all workflow tests
cd packages/workflow
bun test distributed.test.ts
```

---

## Evidence Generation

Phase 5.1 tests automatically write evidence files to:
`docs/vaulltcore/phase5/raw-results/` (Phase 5 tests)
`docs/vaulltcore/phase5.1/` (crash-matrix.json)

Each evidence file contains:
- `sha` — Git commit SHA at time of execution
- `collectedAt` — ISO timestamp
- `verdict` — PASS/FAIL/RECORDED

---

## Environment Notes

- **Soak duration:** The recorded run was 30 seconds (raw `durationSeconds: 30`). The harness
  default is 300s but was not used for the recorded evidence. Override with
  `PHASE5_SOAK_SECONDS=60` for faster runs. Multi-hour endurance is NOT executed here.
- **PG cluster memory:** Local PostgreSQL 14 may be killed by sandbox memory limits under heavy concurrent tests. Restart with `pg_ctlcluster 14 main start` if needed.
- **In-memory tests:** Phase 5.1 tests (reconciliation, retry, fencing, events, credential scan, provider boundary, tenant adversarial, crash matrix) require no external services.
