# Phase 4.1 — Cloudflare Mapping

Cloudflare is the **hosting target** for the control plane, not an owner of the
domain model. The durable layer defines a `SharedBackend` interface; a
Cloudflare deployment provides one backed by Durable Objects.

| Durable concept | Cloudflare primitive | Notes |
| --- | --- | --- |
| `SharedBackend` | Durable Object instance (one per shard) | Single-writer per object → CAS is trivially linearizable; versioning via `expectedVersion` on `state.storage`. |
| Per-key CAS | `DO.blockConcurrencyWhile` + read/compared-write of `JSONRecord` | `MemorySharedBackend` already models this; swap impl only. |
| `DistributedQueue` | DO + `setTimeout` (or `@cloudflare/qs` queue) for visibility-timeout redelivery | Messages kept in an array; claim sets `availableAt`; a scheduled alarm redelivers. |
| Leases | DO single-writer record | `claim` is a CAS on the lease key inside `blockConcurrencyWhile`. |
| Run/step/task state | `state.storage.put/get` (keyed by `tenantKey(tenantId, ...)`) | Tenant namespace prevents cross-tenant reads at the storage layer. |
| Execution plane | Worker → `packages/sandbox` `StepExecutor` over `fetch` | Worker invokes the sandbox, not the DO. Execution is stateless from the DO's view; only checkpoints/leases are durable. |
| Budget | `RunUsage` rows + `guardBudget` in `DurableWorker` | Usage accumulated per step; run fails deterministically on breach. |
| Authn/authz | `apps/web` (Better Auth + Vercel/GitHub OAuth) → tenantId header | The workflow package receives a tenantId and enforces per-resource isolation. |

## Build

`pnpm --dir apps/web build` runs `lib/db/migrate.ts` (Drizzle) on deploy. The
durable layer has **no DB schema additions** (state lives in the backend / DO
storage, not Postgres); Postgres stores only jobs/runs metadata that Drizzle
already manages. No migration required for Phase 4.1.

## What does NOT change for CF

- `contracts.ts`, `model.ts`, `scheduler.ts`, `worker.ts`,
  `distributed-runtime.ts`, `dag.ts`, `authorization.ts` are backend-agnostic.
- Swapping to a DO-backed `SharedBackend` is a ~50-line class implementing
  `SharedBackend`; everything else is untouched.
