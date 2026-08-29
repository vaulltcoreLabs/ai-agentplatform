# Vaulltcore Agent Engine — Test Report (Phase 1)

## Tests added (`packages/agent/engine/`)

| File | Covers |
| --- | --- |
| `errors.test.ts` | redaction, `wrapError`, all taxonomy kinds, cancellation detection |
| `capabilities.test.ts` | provider parsing, defaults, per-model overrides, capability queries |
| `permissions.test.ts` | risk-based decisions, forbidden/allowed overrides, opaque approval |
| `tool-contract.test.ts` | `defineTool` wrapping, `DEFAULT_TOOL_RISK` |
| `subagent-contract.test.ts` | `SubagentResult` validation |
| `model-resolution.test.ts` | provider-neutral resolver, managed credentials, BYOK path |
| `engine.test.ts` | construction, capabilities, state, execution against a mock provider, cancellation via `AbortSignal` |

## Tests preserved

- The existing `packages/agent` test suite (tools, models, context, etc.) remains
  in place and unchanged in behavior.

## Results

- Agent Engine typecheck: **pass** (`tsc --noEmit`).
- Agent Engine tests: **26 pass, 0 fail** (`bun test engine`).
- Agent Engine lint: **0 warnings, 0 errors** (`oxlint`).

## Known pre-existing blocker (NOT caused by Phase 1)

`bun test` across the *entire* `packages/agent` surface also exercises
pre-existing tool files (`tools/*.ts`) that do `import { tool } from "ai"`.
The pinned runtime build `ai@6.0.194` does not export `tool` from its `.mjs`
entry (its `.d.ts` does, so `tsc` still passes). This is a pre-existing
packaging mismatch in the repo, independent of Phase 1 — the new engine code
does not import `tool` and is unaffected. It should be resolved separately
(e.g., align the `ai` version or update the tool helper import) but is outside
the Phase 1 scope and was not introduced by this work.

## Typecheck / lint / build status for the engine

- `typecheck`: pass
- `lint`: pass
- `build`: the engine is a TypeScript source package consumed by `apps/web`;
  no separate build step failed as a result of these changes.
