# Phase 4.1 — Security Model

## Threat model summary

- **Threat**: a tenant that knows (or guesses) a resource id belonging to
  another tenant attempts to read/write it via a shared control plane.
- **Mitigation**: every public runtime entry point (`getJob`, `cancel`,
  `submit` w/ cross-tenant, `getRun`) re-resolves the **owning tenant** of the
  resource via `WorkflowStore.resolveJobTenant(jobId)` and asserts the caller
  tenant matches. Tenant ids namespace every storage key
  (`tenantKey(tenantId, key)`), so even a key-guess cannot escape the namespace.

## Controls

| Control | Where |
| --- | --- |
| Tenant resolution per access | `authorization.ts` (`assertAuthorized`, `resolveJobTenant`) |
| Namespaced storage keys | `DistributedWorkflowStore` / `DistributedCheckpointStore` use `tenantKey(tenantId, ...)` |
| Authorization on every public method | `DistributedDurableRuntime.getJob`, `.cancel`, `.getRunState` |
| Fencing (no stale writes) | Per-key CAS leases + `Step.version` expected-write in `completeStep`/`failStep`/`saveStep` |
| Idempotency (no double-execute by replay) | `idempotencyKey` per step; `DistributedIdempotencyStore` |
| Least privilege executor | `StepExecutor` receives `StepExecution` (scoped to one step + its idempotency key), not run-wide secrets |

## What is NOT in scope (Phase 4.1)

- Transport security (TLS/mTLS) — assumed by the hosting layer (Cloudflare).
- Secret management — credentials for the executor come from the sandbox
  layer (`packages/sandbox`), not the durable layer.
- Authentication of the caller to the runtime API — the runtime trusts the
  `tenantId` passed by the caller; real auth (Vercel/GitHub OAuth) happens in
  `apps/web` before reaching the workflow package.
