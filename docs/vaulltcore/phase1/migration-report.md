# Vaulltcore Agent Engine — Migration Report (Phase 1)

## Moved

- Extracted a clean public boundary `VaulltcoreAgent` (`packages/agent/engine/index.ts`)
  wrapping the existing `ToolLoopAgent`. The engine no longer requires callers
  to understand `ToolLoopAgent` internals.
- Model resolution extracted into `ModelResolver` + `CredentialResolver`
  (`model-resolution.ts`), decoupling provider selection from `gateway` calls.

## Adapted

- `open-agent.ts`: `vaulltcoreAgent` is now produced by `createVaulltcoreAgent(resolveModel?)`
  with an injectable `VaulltcoreAgentResolveModel`. `vaulltcoreAgent` (legacy export) is
  preserved via `createVaulltcoreAgent()` — fully backward compatible.
- `types.ts`: `isSandboxState` no longer hardcodes `"vercel"`; it is now
  provider-neutral.
- `index.ts` (agent): re-exports the new `engine/` boundary (`export * from "./engine"`).
- `models.ts`: attribution branding changed from `Vaulltcore` / `vaulltcore.dev`
  to `Vaulltcore` / `vaulltcore.dev`.

## Preserved

- All 11 tools and their behavior (`tools/`).
- Subagents (`explorer`, `executor`, `design`) and registry.
- Skills discovery/loader/validation.
- Context management (cache-control, compaction).
- Usage accounting.
- System prompt construction.
- Sandbox provider (Vercel) implementation — untouched.

## Removed

- None. No functioning code was deleted. The only deletions were dead
  "vercel"-literal coupling in `isSandboxState`.

## Deferred (explicitly NOT implemented in Phase 1)

- Cloudflare Workers / Workflows / Queues / Durable Objects / R2 / D1.
- Docker / Fly.io / Kubernetes sandbox migration.
- Multi-tenancy, organizations, billing, subscriptions, API-key management,
  SSO, admin console.
- Durable execution / queue workers / workflow replacement.
- Credential storage (the `CredentialResolver` interface exists; storage is
  Phase 4+).
- Full policy engine (the `PermissionResolver` contract exists; the future
  policy platform does not).
