# Vaulltcore Agent Engine — Performance Report (Phase 1)

This is a static review of architectural bottlenecks; no load testing was run.

## Synchronous bottlenecks

- None introduced. Tool execution and model calls remain async. The engine
  facade adds only O(events) iteration over the model stream.

## Global / mutable state

- The engine instance holds only per-run mutable state (`status`, `lastUsage`,
  `runs`, an `AbortController`). There is **no** global mutable state, no
  singleton user state, and no durable filesystem/process-local state. The
  engine is stateless with respect to durable application state (per Rule 16).
- `createVaulltcoreAgent()` produces independent instances.

## Memory risks

- `usage` is aggregated as a single `LanguageModelUsage` object per run; no
  unbounded accumulation.
- Event streaming yields deltas without buffering the entire transcript in the
  engine (callers may buffer if they choose).

## Token inefficiencies (addressed / preserved)

- Context caching preserved (`context-management/cache-control.ts`).
- Subagent specialization preserved (one orchestrator + constrained workers).
- Tool-result compaction preserved (`context-management/aggressive-compaction-helpers.ts`).
- Model selection preserved (`models.ts`).
- Capability system (`capabilities.ts`) prevents future `if model === "x"`
  branching that could force suboptimal/expensive models.

## Subagent explosion risks

- Subagents are bounded by `SubagentSpec.budget` (maxSteps / maxOutputTokens /
  maxDurationMs) in the contract. The orchestrator delegates without spawning
  unbounded identical agents (specialization over duplication, Rules 8–9).

## Unnecessary model calls

- `getCapabilities()` is a pure lookup (no model call). Model resolution is
  per-call and cached by the caller's `ModelResolver` if desired.

## Summary

No architectural bottlenecks were introduced. The engine is horizontally
scalable: it owns no durable state and depends only on injectable,
provider-neutral contracts.
