# Phase 4.3 — Security Policy

## SandboxSecurityPolicy

### Status: IMPLEMENTED

The `SandboxSecurityPolicy` (`packages/sandbox/security.ts`) enforces structured security policies at the provider boundary. Policies are pure functions with no provider SDK dependencies, allowing any `Sandbox` implementation to enforce them.

### Network Egress

- **Policy**: `NetworkPolicyConfig` with `allowedHosts` and `defaultDeny`.
- **Default**: `DENY_ALL_NETWORK` — empty allowlist, `defaultDeny: true`.
- **Vercel hardening**: `DEFAULT_NETWORK_POLICY` changed to `allow: {}` (deny all). `buildGitHubCredentialBrokeringPolicy` lists GitHub hosts explicitly.

### Path Confinement

- **Policy**: `PathPolicyConfig` with `allowedRoot` and `deniedPaths`.
- **Default**: Paths resolved against `allowedRoot`; `../` traversal blocked via `relative()` check.
- **Denied paths**: `.env`, `.env.local`, `.env.*.local`, `.git/config`, `.git/credentials`.

### Command Filtering

- **Policy**: `CommandPolicyConfig` with `deniedCommandPatterns` and `allowedCommandPatterns`.
- **Default denylist**: fork bombs (`:(){:|:&};:`), `rm -rf /`, `chmod 777`, `curl -o /dev/stdin | bash`, `eval $(`, `shutdown`, `reboot`, `halt -p`, `mkfs`.
- Empty allowlist means "all non-denied commands are permitted".

### File Size Ceiling

- **Default**: 10MB (`DEFAULT_MAX_FILE_SIZE_BYTES`).
- Enforced via `checkFileSize()`.

### Adversarial Tests

- **Status: IMPLEMENTED** (`packages/sandbox/security.test.ts`)
- 35 tests covering path traversal, secret file denials, command denylist, network egress (including cloud metadata endpoint `169.254.169.254`), and file size ceiling.

## Future

### Provider-Level Enforcement

- **Status: FUTURE** — The policy functions are pure checks. Actual enforcement at the provider level (wrapping `Sandbox.exec`, `Sandbox.readFile`, etc.) is not yet implemented. A future phase should apply these checks at the Vercel/Docker provider boundary.
