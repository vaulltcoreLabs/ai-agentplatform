# Vaulltcore Agent Engine — Security Report (Phase 1)

## P1 GitHub-token exposure — verified NOT propagated

The Phase 0 P1 issue (GitHub token embedded in sandbox) is **already contained
inside `packages/sandbox`**: `config.ts` marks embedding tokens as *deprecated*,
and `githubToken` is documented as "used only during setup clone/fetch, then
cleared". `packages/agent` never touches GitHub tokens or credentials. The new
engine contracts explicitly forbid credential passage into tools/sandbox.

## Checks performed

- **No Vercel imports inside the engine**: confirmed. Only `@vaulltcore/sandbox`
  (interface) is imported, never `@vercel/sandbox`.
- **No workflow imports inside the engine**: confirmed. The engine is callable
  from any host without a workflow runtime.
- **No OAuth token exposure**: the engine never handles auth tokens; credentials
  are resolved behind `CredentialResolver` and passed only to the provider
  adapter.
- **No provider secret logging**: `redactSecrets()` strips API keys, OAuth
  tokens, authorization headers, and known provider key patterns from any error
  text before it leaves the boundary.
- **No raw authorization-header logging**: same redaction path.
- **Sandbox path containment**: `tools/path-security.ts` enforces `.env`
  protection (`isSensitiveDotEnvPath`) and working-directory containment
  (`resolveWorkspacePath`). Preserved and unaffected.
- **Tool permissions enforced**: `permissions.ts` introduces an explicit
  `PermissionResolver` (`allow`/`approve`/`deny`) with risk-based defaults;
  approval source is opaque.
- **Cancellation cleanup**: `AbortController` propagates to model/tools/sandbox;
  a cancelled run is marked `cancelled` and emits an `agent.failed` event rather
  than silently continuing.
- **Subagent privilege**: subagents inherit the parent's constrained tool set
  and permissions via `SubagentSpec`; they cannot silently gain unrestricted
  privileges.

## Regression tests

- `errors.test.ts` asserts `redactSecrets` removes `sk-…`, `ghp_…`, and
  `api_key=…` material, and that `wrapError` never leaks the raw secret in the
  resulting message.
- `engine.test.ts` asserts cancellation produces a `CancellationError` and a
  `cancelled` status (no silent continuation).
- `permissions.test.ts` asserts forbidden tools are denied and mutating tools
  require approval.

## Conclusion

The P1 GitHub-token issue has **not** been propagated into the new Agent Engine
architecture. The engine adds a secret-redaction boundary and an explicit
permission model on top of the existing path/`.env` protections.
