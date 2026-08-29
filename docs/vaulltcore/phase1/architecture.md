# Vaulltcore Agent Engine — Architecture

This document describes the Agent Engine established in Phase 1 of the
Vaulltcore roadmap. It is the intelligence/execution kernel that sits between the
future Vaulltcore Control Plane and any sandbox provider.

## Package boundaries

```
Vaulltcore Control Plane (Phase 4)        Vaulltcore Execution Fabric (Phase 2)
        │                                          │
        ▼                                          ▼
┌──────────────────────────────┐        ┌──────────────────────────────┐
│     VAULLTCORE AGENT ENGINE  │        │   DURABLE EXECUTION RUNTIME  │
│     packages/agent/engine    │        │        (Phase 2)             │
│                              │        └──────────────────────────────┘
│  • reasoning / planning      │                    │
│  • tool orchestration        │                    ▼
│  • subagents                 │        ┌──────────────────────────────┐
│  • skills                    │        │      SANDBOX INTERFACE        │
│  • context management        │        │  @vaulltcore/sandbox         │
│  • permissions               │        │  (provider-neutral contract)  │
│  • model routing             │        └──────────────────────────────┘
│  • execution policy          │                    │
│  • telemetry (events)        │        ┌──────────────────────────────┐
│  • error taxonomy            │        │  Sandbox Provider (Vercel now)│
└──────────────┬───────────────┘        └──────────────────────────────┘
               │ provider-neutral contract
               ▼
        ┌──────────────────────────────┐
        │   SANDBOX (filesystem, shell,│
        │    git, processes, servers)  │
        └──────────────────────────────┘
```

The engine intentionally does **not** become the sandbox, the workflow engine,
or the web application.

## Execution lifecycle

1. Caller invokes `VaulltcoreAgent.run(input, options)` or `stream(...)`.
2. The engine builds `ToolLoopAgent` call options (`sandbox`, `model`,
   `subagentModel`, `customInstructions`, `skills`) via `createVaulltcoreAgent`.
3. The model is resolved through `ModelResolver → LanguageModel` (no credentials
   stored in the engine).
4. `prepareCall`/`prepareStep` wire the system prompt, cache-control, and tools.
5. Streaming yields provider-neutral `EngineEvent`s; the final result text,
   normalized `usage`, and `state` are available from `getUsage()`/`getState()`.
6. An `AbortSignal` (via `stop()`) propagates to model, tools, and sandbox.

## Subsystem map (new files in `packages/agent/engine/`)

| File | Responsibility |
| --- | --- |
| `errors.ts` | `AgentError` taxonomy + secret redaction |
| `capabilities.ts` | `ModelCapabilities` + provider adaptation |
| `model-resolution.ts` | `CredentialResolver → ModelResolver → LanguageModel` |
| `permissions.ts` | `PermissionResolver` (`allow`/`approve`/`deny`) |
| `tool-contract.ts` | `ToolDefinition` / `VaulltcoreTool` contract |
| `subagent-contract.ts` | `SubagentSpec` / `SubagentResult` contract |
| `events.ts` | provider-neutral `EngineEvent` union |
| `index.ts` | `VaulltcoreAgent` facade + barrel exports |

Preserved subsystems (unchanged in behavior): `tools/`, `subagents/`,
`skills/`, `context-management/`, `usage.ts`, `system-prompt.ts`, `models.ts`.

## Model architecture

- Provider-neutral via the `ai` SDK. OpenAI, Anthropic, and Google are all
  first-class; BYOK is supported architecturally through `CredentialResolver`.
- The engine never branches on `if model === "claude"`. Provider differences
  live in `capabilities.ts` (`getModelCapabilities`) and `models.ts`
  (`getProviderOptionsForModel`).

## Tool architecture

Tools remain the existing set (`todo_write, read, write, edit, grep, glob, bash,
task, ask_user_question, skill, web_fetch`). Each carries a `ToolMetadata`
(identity, risk, category) via `defineTool`. The runner discovers them through
the contract rather than hardcoding business logic.

## Subagent architecture

Specialized workers (`explorer`, `executor`, `design`) are preserved. The new
`SubagentSpec` contract generalizes them: role, instructions, model, constrained
tools, context, budget, result, usage. One strong orchestrator + specialized
workers, not many identical agents.

## Context management

Preserved: `context-management/` (cache-control, aggressive compaction). The
engine continues to operate against the existing `Sandbox` interface only.

## Event model

`EngineEvent` is a discriminated union (`agent.started`, `agent.thinking`,
`agent.tool.started/completed`, `agent.subagent.started/completed`,
`agent.message.delta/completed`, `agent.usage`, `agent.warning`, `agent.failed`,
`agent.completed`). The future workflow/UI/telemetry systems consume these.

## Cancellation

`AbortController` per agent instance; `stop()` aborts the signal, which the
`ai` SDK propagates to model, tools, and sandbox.

## Error model

`AgentError` base + `ModelError`, `ToolError`, `PermissionError`,
`SandboxError`, `ContextError`, `SubagentError`, `ConfigurationError`,
`CancellationError`. Errors are wrapped at the engine boundary; secrets are
redacted (`redactSecrets`).

## Security boundary

- No `@vercel/sandbox` import inside the engine; only the `Sandbox` interface.
- No workflow import inside the engine.
- No credential storage; credentials resolved through `CredentialResolver` and
  never passed into tools or the sandbox.
- `isSandboxState` no longer hardcodes `"vercel"` (provider-neutral).

## Sandbox boundary

The engine depends only on `@vaulltcore/sandbox` (interface). The current
Vercel provider implementation remains untouched.

## Workflow boundary

The engine exposes a plain async `run()`/`stream()` API callable from HTTP,
worker, queue, durable workflow, CLI, or test harness without modification.
