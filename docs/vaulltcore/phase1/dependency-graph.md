# Vaulltcore Agent Engine — Dependency Graph

Verified by static inspection (`grep`/`tsc`) on `packages/agent`.

## What the engine imports

| Module (in `packages/agent/engine/`) | External imports |
| --- | --- |
| `errors.ts` | none (stdlib only) |
| `capabilities.ts` | none |
| `model-resolution.ts` | `ai` (types), `../models` |
| `permissions.ts` | none |
| `tool-contract.ts` | `ai` (`Tool`) |
| `subagent-contract.ts` | `ai` (`LanguageModelUsage`), `../open-agent`, `../skills/types`, `./model-resolution` |
| `events.ts` | `ai` (`LanguageModelUsage`) |
| `index.ts` | `ai`, `../open-agent`, `../skills/types`, `./capabilities`, `./model-resolution`, `./permissions`, `./errors`, `./events` |

`packages/agent` as a whole imports only:
`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@vaulltcore/sandbox`, `zod`,
node built-ins (`path`, `os`, `fs`), and `bun:test` (tests).

## Prohibited dependencies — proven absent

| Forbidden | Status |
| --- | --- |
| `@vercel/sandbox` / `@vercel/workflow` / `workflow` | **Absent.** The engine imports `@vaulltcore/sandbox` (interface only). |
| `better-auth` / DB / ORM | **Absent.** No auth or database import in the engine. |
| `apps/web` / Next.js | **Absent.** Engine has zero web dependency. |
| Credential storage | **Absent.** `CredentialResolver` is an interface; no secret persistence. |

## Required interfaces that remain behind a boundary

- **Sandbox**: the engine sees only `Sandbox` (from `@vaulltcore/sandbox`),
  not any concrete provider.
- **Model**: the engine sees only `LanguageModel` (from `ai`), resolved through
  `ModelResolver`.
- **Permission**: approval source is opaque (`PermissionResolver` contract).

## Result

The Agent Engine is a self-contained, provider-neutral kernel. It can be invoked
from any host (HTTP, worker, queue, durable workflow, CLI, test) and moved onto
Cloudflare, Node, Docker, Fly.io, AWS, or GCP without rewriting the intelligence
layer.
