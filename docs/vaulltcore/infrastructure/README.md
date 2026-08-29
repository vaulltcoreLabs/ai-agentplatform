# Vaulltcore — Infrastructure Separation (Control Plane / Execution Plane)

**Status:** PHASE 4.5 IMPLEMENTED — production SharedBackend adapter, queue
adapter semantics, and runner protocol contracts landed; see §11 and
`acceptance-report.md`.
**Scope:** Controlled infrastructure separation. No Phase 5, no product changes.
Phase 4.1–4.4 contracts and tests are preserved untouched.

This document consolidates the forensic audit, the separated-architecture
proposal, the provider inventory, the memory/cost baselines, and the migration
plan into one entry point. Detailed models already exist per phase and are
referenced rather than duplicated:

- Phase 4.1: `../phase4.1/architecture.md`, `cloudflare-mapping.md`,
  `distributed-model.md`, `failure-model.md`, `consistency-model.md`,
  `security-model.md`, `capacity-model.md`, `migration-plan.md`
- Phase 4.3: `../phase4.3/security.md` (sandbox hardening), `execution.md`
- Phase 4.4: `../phase4.4/priority-fixes.md`

---

## 1. Forensic verdict

The requested separation is **already implemented at the package boundary**.
Verified by source inspection and enforced going forward by
`packages/workflow/boundary.test.ts` (automated import-boundary test).

| Requirement | Status | Evidence |
| --- | --- | --- |
| Agent Engine is provider-neutral | ✅ PASS | Phase 1 dependency graph; engine imports only `ai`, `@ai-sdk/*`, `@vaulltcore/sandbox` interface, zod, node built-ins. No `@vercel/*`, no workflow SDK, no DB/auth/web imports. |
| Workflow is provider-neutral | ✅ PASS | `contracts.ts` declares capability-not-mechanism interfaces; `distributed-store.ts` builds everything on a single injected CAS primitive (`SharedBackend`) — Durable Object, Postgres row, or Redis hash are all valid backends; no provider import anywhere in `packages/workflow`. |
| Sandbox behind an adapter/registry | ✅ PASS | `packages/sandbox/provider.ts` registry + `factory.ts`; app and executor code calls only `connectSandbox` / `createSandbox`. Vercel + Docker providers registered by name (`"vercel"`, `"docker"`). |
| Executor never touches providers | ✅ PASS | `sandbox-executor.ts` receives a `sandboxSupplier` callback; depends only on neutral types from `@vaulltcore/sandbox`. "No Docker/SDK imports leak through here." |
| Queue-is-transport / durable-state-is-truth | ✅ PASS (contract) | Cancellation markers, checkpoints, leases with fencing versions, idempotency keys, `listActiveRunIds` reconciliation hook — all durable-store-backed, not in-memory. |
| Tenant isolation primitives | ✅ PASS | Tenant-salted deterministic ids, tenant-partitioned keys in distributed stores, `TenantScope` quotas. |
| Automated boundary enforcement | ✅ PASS (new) | `packages/workflow/boundary.test.ts` fails CI if a core/control-plane module imports an execution-provider SDK or concrete sandbox subpath. |

## 2. Current architecture map

```
apps/web            Control-plane app (UI, auth, chat, API routes)
  └─ apps/api       Hono API (models proxy, health)          [CONTROL PLANE]
        │
        │  imports @vaulltcore/{agent,sandbox,workflow,intelligence}
        │  via factories & suppliers only
        ▼
packages/workflow   Durable execution contracts + runtime     [ORCHESTRATION]
packages/agent      Agent Engine (provider-neutral kernel)    [ENGINE]
packages/intelligence Planning/policy/budget/redaction        [INTELLIGENCE]
packages/sandbox    Sandbox INTERFACE + registry + providers  [EXECUTION BOUNDARY]
  ├─ vercel/        Vercel Sandbox provider (@vercel/sandbox)
  └─ docker/        Docker/memory-container provider
```

Dependency direction is strictly inward: control plane → workflow/engine →
sandbox interface → provider implementations selected only via the registry.

## 3. Proposed separated architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ CONTROL PLANE (Cloudflare)  │        │ EXECUTION PLANE (Northflank  │
│                             │        │ / BYO compute)               │
│ Web (Workers/Pages)         │        │                              │
│ API + auth (Workers)        │◄──────►│ Vaulltcore Runner (worker.ts │
│ Workflow state (D1/DO/PG)   │ outbnd │  model + SandboxStepExecutor)│
│ Events/checkpoints (D1/DO)  │ proto  │ Sandbox containers           │
│ Object storage (R2)         │        │ Shell/fs/builds/tests/LSP    │
│ Queue (Queues/DO)           │        │ Agent tool execution         │
└─────────────────────────────┘        └──────────────────────────────┘
                 │                                     ▲
        Agent Engine (unchanged, portable) ───────────┘
```

Cloudflare component placement follows `../phase4.1/cloudflare-mapping.md`.
Summary of non-negotiables: **the sandbox never runs on Workers**; customer
code never runs inside the control plane; the Agent Engine stays where it can
hold streaming connections economically (Node-compatible target today).

## 4. Provider-specific code inventory (CORE / ADAPTER / LEGACY)

| Location | Classification | Notes |
| --- | --- | --- |
| `packages/sandbox/vercel/` | ADAPTER | Registered as `"vercel"` in the registry. Isolated behind `Sandbox` interface. |
| `packages/sandbox/docker/` | ADAPTER | Registered as `"docker"`. Proves the registry supports a second execution substrate. |
| `packages/sandbox/interface.ts` | CORE | Provider-neutral. One doc-comment mentions "Vercel snapshot IDs" — cosmetic; `snapshot()` returns an opaque id string. |
| `packages/sandbox/index.ts` exports | ADAPTER surface | Re-exports `connectVercelSandbox` etc. for ops tooling; consumers under test are barred from them by the boundary test. |
| `apps/web/lib/sandbox/config.ts` | ADAPTER (app config) | Base snapshot id / ports defaults for the current deployment. Composition-root config is allowed to name its provider. |
| `scripts/vercel-refresh-base-snapshot.ts`, `scripts/refresh-vercel-token.sh` | LEGACY (ops tooling) | Only sanctioned direct `@vaulltcore/sandbox/vercel` consumer outside the package. Replace when the base image moves off Vercel snapshots. |
| `apps/web/lib/auth/config.ts` (Vercel OAuth) | ADAPTER (control-plane auth) | Sign-in identity provider, not an execution coupling. Swappable without touching packages. |
| `turbo.json` env list (BLOB/KV/Vercel OAuth vars) | LEGACY config | Declares env passthrough; harmless on other hosts. Trim opportunistically. |
| `apps/web/vite.config.ts` externals (`@vercel/sandbox`, `@vercel/oidc`) | BUILD config | Prevents server-only SDKs entering the client bundle during static hosting builds. |
| `packages/workflow/**`, `packages/agent/**`, `packages/intelligence/**` | CORE | Zero provider SDK imports — CI-enforced. |

## 5. Remote execution protocol (design — CONTRACTUAL/FUTURE)

Status: **designed, not implemented.** No Northflank/remote-runner code exists,
and none may be claimed as working until it does.

Chosen mechanism: **worker-initiated outbound WebSocket** to the control plane
(simplest reliable option that traverses NAT/firewalls; SSE+HTTP fallback for
restricted networks). The runner is the existing `packages/workflow/worker.ts`
lifecycle (IDLE→POLL→CLAIM→EXECUTE→HEARTBEAT→CHECKPOINT→COMMIT→RELEASE)
transported over the socket instead of an in-process queue.

Message set (each carries the full execution envelope):

```ts
interface ExecutionEnvelope {
  tenantId: string;
  runId: string;
  taskId: string;
  stepId: string;
  executionId: string;
  messageId: string;
  idempotencyKey: string;
  fencingToken: string;   // lease version — commits are rejected if superseded
  timestamp: number;
}
```

Operations: `register` (+capabilities), `heartbeat`, `claim`, `exec`,
`stdout`/`stderr` chunks, `readFile`, `writeFile`, `cancel`,
`checkpoint`, `complete`, `fail`, `release`.

Truth ownership (mirrors `../phase4.1/failure-model.md`): durable stores own
truth; the queue/socket is transport only. Leases expire; a new worker claims
with version N+1; stale commits fail the fence check; duplicate deliveries are
absorbed by idempotency keys. Exactly-once is **not** claimed — the guarantee
is *at-least-once execution + idempotent side effects*, identical to Phase 4.1.

## 6. Memory baseline (measured 2026-08-24, live processes)

The "~788MB application baseline" is the **full local dev stack**, not a single
service requirement:

| Process | RSS | Role |
| --- | --- | --- |
| Vite dev server (HMR off) | ~330 MB | web UI transform cache |
| pnpm/turbo wrapper chain | ~420 MB combined | process wrappers around vite/tsx — absent in production |
| tsx API server (Hono) | ~92 MB | models proxy + health |

Production split targets (no wrapper overhead, HMR off):

- **Control plane** (web + API): ~450–600 MB total; horizontally splittable.
- **Runner/worker**: ~120 MB (stateless; durable state lives in stores).
- **Sandbox**: separate budget per container profile (512MB / 1GB / 2GB / 4GB),
  enforced by the execution provider — independent of the numbers above.

Do not provision one big machine for all three planes; they scale and fail
independently by design.

## 7. Cost model summary

Assumptions: control plane on metered edge compute; DB managed Postgres (or
D1 where fit); sandboxes billed per-second while active; BYO-compute tenants
contribute runners but no sandbox cost.

| Scale | Idle/mo (approx) | Active driver |
| --- | --- | --- |
| 0 customers | ~$0–5 (DB + storage floor) | nothing running |
| 1 customer | < $10 + LLM | sandbox seconds + tokens dominate |
| 10 | ~$20–40 infra + usage | still sandbox/token-bound |
| 100 | ~$100–200 infra + usage | DO/D1 writes, egress begin to matter |
| 1,000 | usage-dominated | warm-pool economics decision required (see §9) |

Full model with formulas lives in `../phase4.1/capacity-model.md`; this pass
adds the plane-split correction above (control-plane memory ≠ sandbox memory).

## 8. Security posture

Preserved unchanged from Phase 4.3 (`../phase4.3/security.md`): default-DENY
network policy (`DENY_ALL_NETWORK`), explicit allow-lists only, path
confinement, dangerous-command policy checks, secret redaction in errors and
durable events. The separation adds two requirements for any future remote
runner: mutual authentication of runner↔control-plane, and per-tenant envelope
validation at claim time (a runner may only receive work whose envelope it can
cryptographically attribute to its tenant grant).

## 9. Migration plan (incremental — no big bang)

Stage 0 (done): provider-neutral engine + contracts + registry (Phases 1–4.4).
Stage 1 (done this pass): automated boundary test; consolidated docs.
Stage 2 (next, CONTRACTUAL): implement `SharedBackend` adapter #1 (Postgres or
Durable Objects) so `Distributed*` stores run against real durability.
Stage 3: extract the runner into a deployable service speaking §5's protocol
against Northflank; keep Docker provider as local fallback.
Stage 4: migrate control-plane hosting to Cloudflare per the suitability
matrix; retire `scripts/*vercel*` once snapshots move.
Every stage leaves the repo runnable and the existing tests green.

## 10. Acceptance gate

See `acceptance-report.md` for the full Phase 4.5 forensic acceptance matrix.

## 11. Phase 4.5 — what landed

### Layer-2 adapters package (`packages/adapters`)

`@vaulltcore/adapters` is the first LAYER 2 package: it depends on the
workflow contracts, never the reverse. Core packages remain SDK-free
(enforced by `packages/workflow/boundary.test.ts`).

- **`SqliteSharedBackend`** — production `SharedBackend` over SQLite
  (`bun:sqlite`, WAL, `BEGIN IMMEDIATE`). Every mutator (`cas`, `append`,
  `incr`, `del`) is a SINGLE immediate transaction serialized by the database
  engine across independent connections — no read-modify-write round-trips.
  Schema/semantics port directly to Cloudflare D1.
- **`openDurableSqlite(path)`** — composition root wiring all `Distributed*`
  stores + `DistributedQueue` onto one file. Two handles on one path are two
  independent runtimes sharing durable state.

The queue adapter (Workstream D) required no new implementation:
`DistributedQueue` already builds on `SharedBackend`; the real backend gives it
message-id dedup, visibility-timeout leasing, delayed retry, and redelivery on
a durable substrate.

### Runner protocol contracts (Workstreams E/F)

`packages/workflow/runner-protocol.ts` (LAYER 1, provider-neutral):
`ExecutionEnvelope` (tenant/run/task/step/execution/message/idempotency/
fencing fields on EVERY message), `RunnerRegistry` (scoped, revocable,
hashed-token credentials — never a global secret), `RunnerSession`
(CONNECTING→…→ACKNOWLEDGED handshake with legal-transition enforcement,
heartbeats, assignment timeout), `RunnerControlPlane` (tenant-scope gating,
capability declarations, stale-result fencing rejection).
Transport (WebSocket) remains FUTURE by design.

### Measured memory baseline (Workstream I — replaces estimates)

Measured live (RSS, this workspace, preview running):

| Component | Idle | Warm |
| --- | --- | --- |
| Vite dev server | ~330 MB | **785 MB** (module graph + transform cache) |
| API server (tsx/Hono) | ~56 MB | ~163 MB |
| pnpm/sh wrappers | ~230 MB combined | absent in production |
| SQLite backend (per connection) | <1 MB | grows with store size |

**Conclusion:** the historical "~788 MB" figure ≈ one warm Vite dev server.
Production control plane (built static frontend + Node API) targets
~250–400 MB; a runner process ~120 MB; sandboxes budgeted per container.
Do not size production from dev-server numbers.

### Test results (this phase)

| Suite | Result |
| --- | --- |
| adapters/durable-sqlite.test.ts (8 tests: CAS race, concurrent append/incr, F-2 dup submit, F-3 cross-runtime cancel, queue dedup/visibility/retry) | ✅ 8/8 |
| workflow incl. runner-protocol.test.ts (14 tests: auth/revoke/reconnect/handshake/cross-tenant/stale-fencing) | ✅ 232/232 |
| sandbox | ✅ 92/92 |
| intelligence | ✅ 108/108 |
| agent | ⚠️ 46/48 — 2 PRE-EXISTING failures from upstream `ai@6.0.194` dropping the named `tool` export; unrelated to Phase 4.5 (no agent files touched)
