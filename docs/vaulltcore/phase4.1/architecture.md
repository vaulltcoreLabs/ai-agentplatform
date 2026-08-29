# Phase 4.1 — Architecture

## Goal

Transform `packages/workflow` into a **provider-neutral, distributed durable
execution foundation** (Phase 1–4) so the agent loop (`packages/agent`) can
offload work to a sandbox (`packages/sandbox`) via durable steps without
coupling to Cloudflare/Vercel/Docker/Postgres/queues/OpenAI/Anthropic.

```
Web -> Agent (packages/agent) -> Sandbox (packages/sandbox)
                              -> Workflow (packages/workflow)   <-- Phase 4
```

## Components

### Control plane (provider-neutral)

| File | Responsibility |
| --- | --- | --- |
| `contracts.ts` | Framework-agnostic types: `WorkflowStore`, `TaskLeaseStore`, `EventStore`, `CheckpointStore`, `IdempotencyStore`, `Queue`, `StepExecutor`, `StepExecution`, `StepResult`, `SubmitRequest` (with `dag`), `RunUsage`. |
| `model.ts` | Domain model: `Run`, `Task`, `Step`, `Lease`, `RunUsage`, state machine enums. |
| `distributed-store.ts` | `SharedBackend` interface + `MemorySharedBackend` (per-key atomic CAS, visibility-timeout queue). Builds the `Distributed*` stores and `DistributedQueue`. |
| `scheduler.ts` | `DurableScheduler` — dependency satisfaction, deadline/fencing, lease acquisition, crash-recovery step reset, checkpointing. |
| `worker.ts` | `DurableWorker` — claim → release → budget-check → execute → checkpoint → commit (fenced) → finalize (two-phase). |
| `distributed-runtime.ts` | `DistributedDurableRuntime` — submit (DAG planning), poll loop, durable cancellation, authorization, budget. |
| `dag.ts` | `planDag` + `validateDag`. |
| `authorization.ts` | `resolveJobTenant`-based gate on every public method (F-10). |

### Execution plane

`StepExecutor` (in `contracts.ts`) is the **only** contract the runtime needs
from an execution backend. `packages/sandbox` provides the default; any sandbox
(Docker, Firecracker, Cloudflare Workers) replaces it without touching the
durable layer (**BYOS**).

### Run state machine

```
queued -> running -> verifying -> completed
                    \-> failed
running -> canceled (via durable cancellation marker)
```

Two-phase finalize (`running → verifying → completed`) makes the final
transition crash-safe: a crash in `verifying` lets any worker re-observe all
tasks terminal and re-run finalize.

## Distributed semantics

| Hazard | Mechanism |
| --- | --- |
| Crash-restart mid-step | Lease expiry + queue visibility-timeout redelivery; `releaseSteps` resets orphaned `running`/`waiting` step to `queued`. |
| Concurrent workers | Per-key atomic CAS on `MemorySharedBackend` → linearizable leases + step-version fencing (F-1). Stale commits rejected by `completeStep` version check. |
| Concurrent submit | Idempotency store dedupes identical `idempotencyKey` (F-2). |
| Cross-process cancel | Durable cancellation marker observed by every worker on poll (F-3). |

## Mapping to Cloudflare

Cloudflare is the **hosting target only**, not an architectural owner:

| Concern | Cloudflare primitive |
| --- | --- |
| Shared durable state | Durable Objects (single writer + versioning) |
| Leases / single-flight | Durable Object + fetch CAS |
| Queue | Durable Objects + setTimeout (or `@cloudflare/qs`) |
| Execution | Worker → `packages/sandbox` StepExecutor over fetch |
| Budget / billing | Per-step usage accumulation in worker |
| Tenant isolation | DO namespace key + `resolveJobTenant` gate |

A Cloudflare build swaps `MemorySharedBackend` for a Durable-Object-backed
`SharedBackend` impl; **no change to contracts or runtime is required**.

## Design rationale

- **Single authoritative release**: `releaseSteps` returns exactly one runnable
  step per poll — avoids leasing steps a worker won't execute. Parallelism
  comes from multiple polls / multiple workers.
- **Two-phase finalize**: explicit `verifying` makes crash recovery observable.
- **Re-enqueue after ack**: completion re-enqueues the run message *after* the
  prior message is ack'd, so the queue's per-message dedup never rejects the
  re-enqueue (at-least-once across crash boundaries).
- **Authorization at the edge**: every public method re-resolves the resource's
  owning tenant and gates, so a worker holding a foreign resource id cannot
  access it (F-10).
