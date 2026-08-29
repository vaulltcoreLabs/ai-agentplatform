# Vaulltcore Agent Engine — Phase 2 Boundary

Phase 1 delivered a **stateless, provider-neutral Agent Engine**. Phase 2 owns
**Durable Execution**. This document defines the seam between them.

## What Phase 1 already provides for Phase 2

- A plain async API: `run(input, options)` / `stream(input, options)`.
- Provider-neutral `EngineEvent`s (`agent.started`, `tool.started`, `subagent.*`,
  `usage`, `completed`, `failed`, …) — the durable runtime can persist/replay
  these.
- Normalized `usage` and `state` (`getUsage`, `getState`) — cost accounting is
  already separable.
- `AbortSignal` cancellation — maps onto workflow cancellation.
- No durable state owned by the engine — durability is the runtime's job.

## What Phase 2 must implement to connect

```
Vaulltcore Agent Engine            Durable Execution Runtime (Phase 2)
─────────────────────────         ───────────────────────────────────
run() / stream()    ─────────────►  workflow step / durable task
EngineEvent[]       ─────────────►  persisted event log (resume/replay)
AbortSignal         ─────────────►  workflow cancellation
(options: sandbox,                (Phase 2 supplies sandbox handle,
 model, skills)                   model config, execution context)
                                     │
                                     ▼
                              Sandbox Interface ──► Provider
```

### Contract points

1. **Invocation**: Phase 2 wraps `VaulltcoreAgent.run/stream` in a durable step.
   No engine change required — the API is already host-agnostic.
2. **Resumption**: `EngineEvent` + last message state let the runtime resume a
   partially-completed run without re-running completed steps. The engine
   should later expose a `resume(messages, options)` overload; not needed in
   Phase 1.
3. **State**: the runtime owns message history, sandbox lifecycle, and
   credentials. The engine receives them per call and returns events/usage.
4. **Model config**: Phase 2 resolves `ModelSelection` (incl. BYOK via
   `CredentialResolver`) and passes it to the engine.
5. **Observability**: `EngineEvent` feeds the future telemetry system; the
   engine does not need to know about it.

## Out of scope for Phase 2 (later phases)

- Sandbox/compute migration (Phase 3).
- Multi-tenancy / B2B control plane (Phase 4).
- Scale/security/economics/platform expansion (Phase 5).

## Key principle preserved

> Vaulltcore owns the intelligence. Infrastructure (workflow, sandbox, cloud,
> model provider, database) is replaceable.

Phase 2 can be built around the engine without rewriting the agent
architecture, because the engine already depends only on injectable,
provider-neutral contracts.
