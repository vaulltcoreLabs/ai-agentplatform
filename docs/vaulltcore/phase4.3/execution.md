# Phase 4.3 — Execution

## Status: IMPLEMENTED

## SandboxStepExecutor

`packages/workflow/sandbox-executor.ts` implements `StepExecutor` and bridges the Workflow layer to the Sandbox + Agent Engine.

### Execution Flow

1. Check if `signal` is already aborted → return cancellation `StepResult`.
2. Call `sandboxSupplier(execution)` to provision a sandbox (lazy, scoped to the step).
   - Propagates the step deadline as a timeout on sandbox provisioning.
   - If provisioning fails: throws `SandboxExecError` (caller decides retry).
   - If `sandboxSupplier` is absent: runs as a pure model task.
3. Build `AgentSandboxContext` from the sandbox's state/working directory.
4. Build the agent prompt from the `Step` spec, `Task` input, and execution context.
5. Call `agent.run(prompt, runOptions)` with the abort signal.
6. On success: return `StepResult` with output, usage, and checkpoint hints.
7. On failure: classify error via `classifyError` + `classifyForDurable`, return `StepResult` with `error`.
8. Always `sandbox.stop()` in `finally`.

### Failure Classification

| Error Type | FailureClass | Retryable |
|---|---|---|
| `AbortError` | `cancellation` | false |
| Generic Error | `tool` (fallback) | true |
| Sandbox provision error | `sandbox` | true |

### Tests

- **Status: IMPLEMENTED** (`packages/workflow/sandbox-executor.test.ts`)
- 9 tests: immediate cancellation, successful execution, sandbox provisioning failure, agent error classification, AbortError classification, checkpoint hints, no-sandbox mode, always-stops-sandbox, prompt building.

## Idempotency & Submission

`packages/workflow/runtime.ts` enforces idempotency at two levels:

1. **Content-addressable job ID**: `createDurableJobId(tenantId, objective)` is deterministic.
2. **Idempotency key**: `IdempotencyStore.record/look` deduplicates exact duplicate submissions.

### Submission Validation

- `validateObjective()` rejects empty, whitespace-only, null, oversized, and null-byte-containing objectives.
- Throws `SubmissionValidationError` before any durable state is created.

## Chaos & Fault Injection Tests

- **Status: IMPLEMENTED** (`packages/workflow/runtime.chaos.test.ts`)
- 13 tests covering: sandbox crash recovery, persistent sandbox crash, delayed provisioning, verification pass/fail/crash, sandbox stop failure, executor retryable errors, executor throws, idempotency dedup, and submission validation.
