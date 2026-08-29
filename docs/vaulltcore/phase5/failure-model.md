# Phase 5 — Failure Model (Neon × R2)

No distributed transaction spans PostgreSQL and R2. Correctness under partial failure is
achieved by (1) idempotent artifact identity, (2) a fenced lifecycle state machine, and
(3) reconciliation.

## Failure matrix

| # | Failure | Detected at | Behavior | Final state |
|---|---------|-------------|----------|-------------|
| 1 | DB reservation OK, R2 PUT fails | client upload | metadata UPLOADING, no object | safe; retry reuses key |
| 2 | R2 PUT OK, confirm network fails | `confirmUpload` | metadata UPLOADING | safe; re-confirm idempotent |
| 3 | Confirm: HEAD R2 missing | `confirmUpload` | → FAILED | no dangling READY |
| 4 | R2 HEAD fails | `confirmUpload` | stays UPLOADING; retry | no READY |
| 5 | R2 GET fails | download | error, no URL | metadata unchanged |
| 6 | R2 PUT fails (server) | reserve/upload | client retries | same object key |
| 7 | R2 DELETE fails | delete | stays DELETING | reconcile retries + purges |
| 8 | Duplicate confirm | confirm | idempotent (READY→READY) | one row, no dup |
| 9 | Expired presigned URL | client upload | client must re-reserve | no partial READY |
| 10 | Wrong content-type on PUT | R2 signature | upload rejected | metadata stays UPLOADING |
| 11 | Wrong tenant request | metadata query | null row → 403/404 | no cross-tenant access |
| 12 | Nonexistent artifact | metadata query | null → 404 | safe |
| 13 | Object replaced before confirm | confirm HEAD | size/sha re-validated | metadata reflects actual object |

## Crash windows (per boundary)
- reserve metadata → upload → confirm → READY → download → delete → reconcile.
- Each transition is a single fenced DB statement (`transition` WHERE lifecycle=expected).
  A crash between DB-commit and R2-op leaves a recoverable state (UPLOADING/DELETING);
  reconciliation converges. Never "atomic across both" — convergence + idempotency instead.

## Reconciliation (runs per tenant)
- A: READY + object missing → FAILED.
- B/E: object with no metadata → reported orphan (not deleted blindly).
- C: DELETING + object present → delete + purge.
- D: UPLOADING past 30-min grace → FAILED.
- Idempotent and observable (returns scanned/repaired counts + details).

## Retry discipline
- No generic `catch => retry`. DB writes are atomic single statements; idempotency is a
  DB property (CAS/ON CONFLICT). Artifact confirm/delete are explicit no-ops on repeat.
- A failed worker cannot create unlimited duplicate objects: the object key is deterministic
  from (tenant,run,artifactId); retries reuse it.
