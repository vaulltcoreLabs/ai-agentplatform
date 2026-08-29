# Phase 4.4 — Security Audit

## Enforcement model (after hardening)

```
Agent tool call
   → getSandbox(experimental_context)            [packages/agent/tools/utils.ts]
       → connectSandbox(state)                   provider reconnect
       → enforceSecurityPolicy(sandbox, policy)  [packages/sandbox/policy-enforcement.ts]
            → confinePath / isPathDenied / checkCommand / checkFileSize
   → inner sandbox I/O only if every check passes
```

Violations throw `SandboxPolicyViolationError` (extends `SandboxError`) as
**rejected promises** — they surface through normal tool error paths and the
durable failure classifier, not as escaping synchronous throws.

## What is enforced, where

| Control | Enforcement point | Status |
|---|---|---|
| Path confinement (traversal, absolute escape) | wrapper: readFile, readFileBuffer, writeFile, stat, access, mkdir, readdir | IMPLEMENTED (when policy configured) |
| Secret-file denial (`.env*`, `.git/config`, `.git/credentials`) | same, via `isPathDenied` | IMPLEMENTED |
| File-size ceiling (10 MB default) | writeFile | IMPLEMENTED |
| Command denylist (fork bomb, `rm -rf /` variants, mkfs, shutdown…) | exec + execDetached, whitespace-normalized matching | IMPLEMENTED |
| Command allowlist mode | exec + execDetached | IMPLEMENTED |
| cwd confinement for shell commands | exec + execDetached | IMPLEMENTED |
| Network egress allowlist/deny-by-default | **policy data exists; no socket-level enforcement** | CONTRACTUAL |
| Cloud-metadata blocking (`169.254.169.254`) | via network policy | CONTRACTUAL |
| DNS rebinding / redirect / proxy abuse | not addressed at this layer | FUTURE (provider responsibility) |
| Symlink/hardlink escape inside container | partially mitigated by provider isolation; path checks operate on request paths | CONTRACTUAL |
| `/proc`, `/sys`, `/dev` access | blocked by path confinement at the API boundary; raw shell can still name them if command policy allows | PARTIAL |
| CPU/memory/process limits | delegated to provider (Docker/Vercel) runtime config | CONTRACTUAL |
| stdout/stderr caps | providers truncate output | IMPLEMENTED (providers) |
| Execution duration | deadline → AbortSignal → sandbox signal propagation | IMPLEMENTED |

## Honest scope statement

Policy enforcement activates when a `securityPolicy` is attached to the
execution (`SandboxStepExecutor` → agent context). Without one, behavior is
unchanged (provider defaults). Making a policy mandatory per-tenant/product is
a deployment decision, deliberately not forced in code to avoid breaking
existing integrations mid-phase.

Network egress deserves emphasis: `checkHost` is correct and tested, but a
command string cannot prove which sockets it opens. True egress enforcement
requires provider-level support (DNS + connect hooks or network namespaces).
Until then, "deny-by-default network" is **CONTRACTUAL**, not IMPLEMENTED.

## Tenant isolation

- Jobs are keyed `(tenantId, jobId)`; runs/tasks/steps are reached only through
  tenant-gated job lookups in both runtimes.
- `assertAuthorized(caller, resource)` gates cancel/getJob/streamEvents;
  distributed `submit()` additionally requires `assertTenantKnown`.
- Events are redacted before leaving the runtime (`redactDurableEvent`).
- Memory APIs are tenant-scoped by signature.
- Store-level access (`getRun(runId)` etc.) is *not* independently tenant-gated;
  safety depends on all external access flowing through the runtime entry
  points. Acceptable today (single library boundary), but any future direct
  store exposure must add per-resource tenancy checks. Flagged as P2 follow-up.

## Test coverage added this phase

- `packages/sandbox/policy-enforcement.test.ts`: 11 adversarial cases
  (traversal, secret files, fork bombs with spacing variants, oversized
  writes, detached exec, lifecycle transparency)
- `packages/agent/tools/utils.test.ts`: getSandbox wraps live sandbox when
  policy present; traversal + denied command rejected; legit ops pass
- `packages/workflow/sandbox-executor.policy.test.ts`: policy reaches agent
  context; absent policy leaves behavior unchanged
