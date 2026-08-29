# Vaulltcore — Phase 1: Agent Engine

## Status: IMPLEMENTED (boundary contracts + branding)

This document is the **required pre-implementation artifact**. It records the
forensic audit of the existing `packages/agent` implementation and the concrete
implementation plan for Phase 1. No source files were modified before this
document and the dependency map below were established.

Implementation complete for the Agent Engine boundary:
- `packages/agent/engine/` — errors, capabilities, model-resolution,
  permissions, tool-contract, subagent-contract, events, and the
  `VaulltcoreAgent` facade.
- `open-agent.ts` refactored to `createVaulltcoreAgent(resolveModel?)` (legacy
  `vaulltcoreAgent` preserved).
- `types.ts` `isSandboxState` made provider-neutral.
- Branding updated to Vaulltcore (`models.ts`, error message).
- All 7 deliverable docs (A–G) produced in `docs/vaulltcore/phase1/`.
- Typecheck passes, engine tests pass (26/26), lint clean.

---

## 1. Forensic audit — what actually exists today

### 1.1 Package boundaries (actual)

| Package | Role | Coupling to forbidden layers |
| --- | --- | --- |
| `packages/agent` (`@vaulltcore/agent`) | Agent engine: `ToolLoopAgent`, tools, subagents, skills, context mgmt, usage | **Clean.** No `@vercel/*`, no `workflow`, no `better-auth`, no DB, no `apps/web`. |
| `packages/sandbox` (`@vaulltcore/sandbox`) | Sandbox **interface** + Vercel provider impl | Imports `@vercel/sandbox` — but that is an *implementation detail* behind `Sandbox` interface. Agent depends only on the interface. |
| `packages/shared` | Shared utilities | Neutral. |
| `apps/web` | Next.js app, workflows, auth, chat UI | Consumes `@vaulltcore/agent` + `@vaulltcore/sandbox`. |

### 1.2 `packages/agent` external imports (verified)

```
ai                         (Vercel AI SDK — provider-neutral model/tool runtime)
zod                        (schema validation)
@ai-sdk/openai             (OpenAI provider adapter)
@ai-sdk/anthropic          (Anthropic provider adapter)
@vaulltcore/sandbox       (Sandbox INTERFACE only)
node:* / path / os / fs    (tool-side path/fs utilities, sandbox-scoped)
bun:test                  (tests)
```

**No** direct `@vercel/sandbox`, `@vercel/workflow`, `better-auth`, `drizzle`,
or `next` imports exist in `packages/agent`. The only `"vercel"` string matches
are: comments, test fixtures, and a single latent bug in `types.ts` (see 1.4).

### 1.3 Subsystem inventory (audited)

- **Agent construction** — `open-agent.ts`: a `ToolLoopAgent` singleton with
  `prepareStep` (cache-control) and `prepareCall` (per-call model + system
  prompt resolution from `callOptionsSchema`).
- **Model abstraction** — `models.ts`: `gateway(modelId, opts)` wraps
  `createGateway` + `wrapLanguageModel`. Provider-specific options live in
  `getProviderOptionsForModel` (anthropic thinking, openai `store:false`).
- **Tool registry** — `tools/`: `todo_write, read, write, edit, grep, glob,
  bash, task, ask_user_question, skill, web_fetch`. Each is a factory or object.
- **Subagents** — `subagents/`: `explorer`, `executor`, `design` (specialized
  `ToolLoopAgent`s), `registry`, `constants`. Currently 3 specialized agents.
- **Skills** — `skills/`: discovery, loader, validation, frontmatter schema.
- **Context** — `context-management/`: cache-control, aggro compaction helpers.
- **Usage** — `usage.ts`: `LanguageModelUsage` aggregation + task-tool usage.
- **System prompt** — `system-prompt.ts`: builds instructions from cwd/branch/
  skills/model.
- **Permissions** — `tools/bash.ts`: `commandNeedsApproval` regex-based check;
  `path-security.ts`: `.env` protection. No formal `PermissionResolver`.

### 1.4 Latent couplings / issues found (must fix in Phase 1)

1. **`packages/agent/types.ts:36`** — `isSandboxState` checks
   `value.type === "vercel"`, but `SandboxType` is actually `"cloud"`. This is a
   hardcoded provider literal inside the engine. → Make provider-neutral.
2. **No `ModelCapabilities`** — provider adaptation is done via
   `modelId.startsWith("anthropic/")` / `"openai/"` string checks in `models.ts`.
   → Introduce capability descriptors (Rule 5).
3. **No `PermissionResolver` contract** — approval logic is inline regex in
   `bashTool`. → Extract contract (Rule 7).
4. **No formal `Tool` contract** — tools are ad-hoc factories/objects. →
   Add a `ToolDefinition` contract (Rule 6).
5. **No provider-neutral event model** — streaming is raw `ai` SDK deltas. →
   Add `EngineEvent` types (Rule 17).
6. **No error taxonomy** — raw SDK/provider errors propagate. → Add
   `AgentError` hierarchy (Rule 19).
7. **No subagent contract** — subagents are bespoke `ToolLoopAgent`s. → Add
   `SubagentSpec` contract (Rules 8–9).
8. **No `BYOK`/credential boundary** — `gateway` takes `apiKey`/`baseURL`
   inline. → Add `CredentialResolver → ModelResolver → LanguageModel` contract
   (Rule 4, 23).

### 1.5 P1 GitHub-token exposure — verified NOT propagated into the engine

The Phase 0 P1 issue (GitHub token in sandbox) is **already contained inside
`packages/sandbox`**: `config.ts` marks embedding tokens as *deprecated*, and
`githubToken` is documented as "used only during setup clone/fetch, then
cleared". `packages/agent` never touches GitHub tokens or credentials. The new
engine contracts will explicitly forbid credential passage into tools/sandbox.

---

## 2. Dependency graph (target after Phase 1)

```
packages/agent  (Vaulltcore Agent Engine)
  ├─ ai                         (provider-neutral model/tool runtime)
  ├─ @ai-sdk/openai             (OpenAI = first-class Vaulltcore provider)
  ├─ @ai-sdk/anthropic          (Anthropic adapter)
  ├─ @vaulltcore/sandbox       (Sandbox INTERFACE only)
  ├─ zod
  └─ node:* (sandbox-scoped path/fs utilities)

FORBIDDEN (proven absent, must stay absent):
  ✗ @vercel/sandbox            → only behind Sandbox interface in packages/sandbox
  ✗ workflow / @vercel/workflow
  ✗ better-auth / drizzle / next / apps/web
  ✗ credential storage
```

---

## 3. Implementation plan (incremental, non-breaking)

Each step ends with: typecheck (`pnpm --dir packages/agent typecheck`) + relevant
tests (`bun test packages/agent`). Existing `vaulltcoreAgent` export is preserved
(legacy compatibility) — the engine is **added**, not a rewrite.

### Step 1 — `engine/errors.ts`
`AgentError` base + `ModelError, ToolError, PermissionError, SandboxError,
ContextError, SubagentError, ConfigurationError, CancellationError`.
`wrapError(err, ctx)` normalizes unknown errors and **strips secrets**
(API keys, OAuth tokens, authorization headers) from messages/stacks.

### Step 2 — `engine/capabilities.ts`
`ModelCapabilities` (reasoning, toolCalling, vision, structuredOutput,
streaming, parallelToolCalls, contextWindow, maxOutputTokens, inputCaching,
computerUse). `getCapabilities(modelId)` registry with provider adapters;
provider-specific detection isolated here (kills `if model === "claude"`).

### Step 3 — `engine/model-resolution.ts`
`ModelSelection { provider, model, credentialRef?, runtimeConfig? }`,
`CredentialResolver` (no storage), `ModelResolver` (returns `LanguageModel`),
`createModelResolver({ gateway })` default impl using existing `gateway`.
OpenAI is a first-class provider. BYOK supported architecturally.

### Step 4 — `engine/permissions.ts`
`ToolRequest`, `PermissionDecision` (`allow|approve|deny`),
`PermissionResolver`, `defaultPermissionResolver` preserving current regex
behavior. Source of approval (UI/API/policy) is opaque to the engine.

### Step 5 — `engine/tool-contract.ts`
`ToolDefinition` (identity, description, inputSchema, outputSchema, execute,
permissions, risk, metadata) + `defineTool` helper. Adapters wrap existing
tool factories without duplicating logic.

### Step 6 — `engine/subagent-contract.ts`
`SubagentSpec` (role, instructions, model, tools, permissions, context, budget,
result, usage). Generalize current `SubagentType`; keep specialization over
duplication.

### Step 7 — `engine/events.ts`
`EngineEvent` discriminated union (started, thinking, tool.started,
tool.completed, subagent.started/completed, message.delta, message.completed,
usage, warning, failed, completed). Provider-neutral.

### Step 8 — `engine/index.ts` (Vaulltcore Agent Engine facade)
`createVaulltcoreAgent({ resolveModel })` factory building a `ToolLoopAgent`
with the **existing** tools/system-prompt/cache-control, parameterized by an
injectable model resolver (default = `gateway`). Exposes the conceptual API:
`run()`, `stream()`, `stop()` (AbortController), `getCapabilities()`,
`getUsage()`, `getState()`. `vaulltcoreAgent` becomes `createVaulltcoreAgent()` (default
resolver) — fully backward compatible.

### Step 9 — Decouple `types.ts`
Fix `isSandboxState` to be provider-neutral (any `SandboxType`), removing the
`"vercel"` literal.

### Step 10 — Re-export + docs + tests
- `packages/agent/index.ts` re-exports `engine/*` (Vaulltcore terminology).
- Tests: `errors`, `capabilities`, `permissions`, `tool-contract`,
  `subagent-contract`, `engine` (mock provider via `ai/test`, no network).
- Deliverable docs A–G in `docs/vaulltcore/phase1/`.
- Run `pnpm run ci` (check + typecheck + tests) before declaring done.

---

## 4. Definition-of-done gate (subset executable this session)

- Agent Engine has a clean public boundary (`VaulltcoreAgent`).
- Provider-neutral: OpenAI + Anthropic behind `ModelResolver`; capability system
  present; no `if model === "claude"` in new code.
- No new Vercel/workflow/DB/web/credential coupling.
- `isSandboxState` no longer hardcodes `"vercel"`.
- Tests cover the new boundaries; typecheck + lint + build pass.
- Docs A–G produced; P1 token issue confirmed not propagated.
