# Phase 4.3 — Execution Pipeline & Sandbox Hardening

## Overview

Phase 4.3 wires real execution through the full pipeline and hardens the sandbox boundary. This is the concrete execution layer that bridges the Phase 3 intelligence engine to the Phase 4 durable workflow runtime.

```
ExecutionPlan (Phase 3) → Workflow (Phase 4) → StepExecutor → Sandbox → Agent Engine
```

## Implemented

### SandboxStepExecutor (`packages/workflow/sandbox-executor.ts`)

- **Status: IMPLEMENTED**
- Implements the `StepExecutor` contract from `contracts.ts`.
- Translates a `StepExecution` (carrying `Step`, `Task`, `Job`, `Lease`, deadline, idempotency key) into an agent prompt + `AgentSandboxContext`.
- Propagates the `AbortSignal` (carrying run-level cancellation + step deadline) into the agent's `abortSignal`.
- Maps agent results/errors onto `StepResult`, classifying failures using the Phase 3 `FailureClass` taxonomy.
- **Provider-neutral**: depends only on `@vaulltcore/agent`, `@vaulltcore/sandbox`, and `@vaulltcore/intelligence` — no Docker/Vercel/Cloudflare SDK imports.
- Supports an injected `agentSupplier` for testing and a configurable `sandboxSupplier` factory.
- Always stops the sandbox in a `finally` block, even on agent failure.

### SandboxSecurityPolicy (`packages/sandbox/security.ts`)

- **Status: IMPLEMENTED**
- Structured security policies enforced at the provider boundary:
  - **Network egress**: deny-by-default with explicit allowlist (`NetworkPolicyConfig`).
  - **Path confinement**: all file operations resolved against an allowed root, blocking `../` traversal (`PathPolicyConfig`).
  - **Command allowlist/denylist**: pre-exec filtering (`CommandPolicyConfig`).
  - **File-size ceiling**: configurable byte limit (`maxFileSizeBytes`).
- Policies are pure functions (`checkHost`, `confinePath`, `isPathDenied`, `checkCommand`, `checkFileSize`) — no provider SDK imports.
- `defaultSecurityPolicy(workingDirectory)` provides deny-by-default defaults.

### Vercel Network Hardening (`packages/sandbox/vercel/sandbox.ts`)

- **Status: IMPLEMENTED**
- `DEFAULT_NETWORK_POLICY` changed from `allow: { "*": [] }` (allow-all) to `allow: {}` (deny-by-default).
- `buildGitHubCredentialBrokeringPolicy` lists GitHub hosts explicitly; the bare `"*": []` key is removed.

### Bounded Output (`packages/sandbox/docker/cli-runtime.ts`)

- **Status: IMPLEMENTED**
- `MAX_BUFFER_BYTES` reduced from 64MB → 2MB.
- `MAX_OUTPUT_BYTES` (1MB) enforces output truncation with `truncated: true` flag.
- `SandboxProvisionError` thrown on file write exceeding the size ceiling.

### Idempotency & Submission Validation (`packages/workflow/runtime.ts`)

- **Status: IMPLEMENTED**
- `validateObjective()` is called before any durable state creation — rejects empty, whitespace-only, null, and oversized objectives.
- `SubmissionValidationError` thrown on validation failure.
- Idempotency: duplicate submissions with the same `idempotencyKey` return the prior `SubmitResult` from `IdempotencyStore`.
- Job IDs are content-addressable from `(tenantId, objective)`.

### Verification (`packages/workflow/runtime.ts`)

- **Status: IMPLEMENTED**
- When `verifier` + `sandboxSupplier` are configured, the runtime provisions a sandbox and calls `verifier.verify()` after all tasks complete.
- Failed verification transitions the run to `failed` with reason `verification_failed`.
- Verifier errors (throws) are caught and treated as verification failure.
- Passing verification transitions to `completed`.
- Without verifier/supplier: best-effort (run transitions directly to `completed`).

## Contractual

### VerificationContext Outcome Mapping

- **Status: CONTRACTUAL** — The `runVerification` method maps task statuses to `TaskOutcome` for the `VerificationBackend`. Tasks in `queued`, `running`, or `completed` states are considered candidates. Tasks in `failed` or `cancelled` states are excluded.

### Sandbox Lifecycle in Verification

- **Status: CONTRACTUAL** — The sandbox provisioned for verification is stopped in a `finally` block. Stop failures are caught and do not affect the verification result.

## Future

### Full Step Result Population

- **Status: FUTURE** — The `runVerification` method currently builds `TaskOutcome` with `output: undefined` and `usage: undefined`. A future phase should populate these from `Step.output` and `Step.usage` stored on the completed step.

### executeTask completeStep Return Value

- **Status: FUTURE** — `executeTask` calls `scheduler.completeStep()` but does not check the return value. A future phase should inspect `StepCompletionResult` and treat `lease_lost` or `version_conflict` as a retryable failure.

### VerificationBackend Default Checks

- **Status: FUTURE** — The `runVerification` method passes an empty checks array `[]` to `verifier.verify()`. A future phase should pass the default check set (`output-present`, `no-error`, `tests-pass`, `lint-clean`, `typecheck`, `no-uncommitted-changes`).
