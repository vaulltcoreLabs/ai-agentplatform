# Phase 4.4 — Hardening Report

## Changes

### H1 — Fix misdiagnosed agent test failures (test-pollution bug)
- **Files:** `packages/agent/models.test.ts`
- **Root cause:** `mock.module("ai", …)` replaced the process-wide module
  registry under Bun; later-loaded files importing `tool` crashed with
  `Export named 'tool' not found` — previously blamed on `ai@6.0.194`.
  Independently verified: Node imports `tool` from that exact module fine.
- **Fix:** spread the real `ai` namespace into the mock.
- **Before:** 46 pass, 2 files erroring (~27 tests silently never ran).
  **After:** 74 pass / 0 fail.

### H2 — Enforce SandboxSecurityPolicy at the tool I/O boundary (P0)
- **Files:**
  - `packages/sandbox/policy-enforcement.ts` (new): `enforceSecurityPolicy`
    decorator + `SandboxPolicyViolationError`; async rejection semantics
  - `packages/agent/open-agent.ts`: `AgentSandboxContext.securityPolicy`
  - `packages/agent/tools/utils.ts`: `getSandbox()` wraps the live sandbox
  - `packages/workflow/sandbox-executor.ts`: policy flows into agent context
  - `packages/sandbox/index.ts`: exports
- **Why this shape:** tools reconnect from serialized state via
  `connectSandbox(state)` — wrapping the executor's local instance would have
  intercepted nothing. The first attempt did exactly that and was caught in
  review before commit; enforcement now lives at the single choke point every
  tool uses.
- **Tests:** sandbox adversarial suite (11), agent getSandbox wrap test,
  workflow context-wiring tests (2).

### H3 — Close command-denylist evasions (P1)
- **File:** `packages/sandbox/security.ts`
- Whitespace-normalized matching (`":(){ :|:& };:"` no longer evades the
  fork-bomb pattern); added `rm -fr /`, `rm -r -f /`, `rm -f -r /`.
- **Test:** regression cases in `security.test.ts`.

### H4 — Prophylactic mock hygiene
- **File:** `packages/agent/tools/utils.test.ts` — same partial-mock hazard as
  H1 existed for `@vaulltcore/sandbox`; fixed identically.

## Files changed

```
packages/agent/models.test.ts                 M
packages/agent/open-agent.ts                  M
packages/agent/tools/utils.test.ts            M
packages/agent/tools/utils.ts                 M
packages/sandbox/index.ts                     M
packages/sandbox/policy-enforcement.ts        A
packages/sandbox/policy-enforcement.test.ts   A
packages/sandbox/security.ts                  M
packages/sandbox/security.test.ts             M
packages/workflow/sandbox-executor.ts         M
packages/workflow/sandbox-executor.policy.test.ts A
docs/vaulltcore/phase4.4/*                    rewritten (purged false claims)
```

## Verification log

| Check | Before | After |
|---|---|---|
| workflow tests | 216 pass / 0 fail | 218 / 0 |
| intelligence tests | 108 / 0 | 108 / 0 |
| sandbox tests | 92 / 0 | 105 / 0 |
| agent tests | 46 pass, 2 load errors | 74 / 0 |
| typecheck (agent, intelligence, sandbox, workflow, web) | pass | pass |
| lint/format (`pnpm check`) | 0 errors | 0 errors |

Note: a full-repo `pnpm typecheck` via turbo was observed to kill the web
typecheck with exit 137 (OOM) when run in parallel in this environment;
each package's typecheck passes individually. No web sources were modified.

## Known pre-existing failures

None. The two "known" agent failures are resolved *because their actual cause
(test pollution) was fixed* — not by weakening or skipping tests. The `ai`
dependency itself was never broken.
