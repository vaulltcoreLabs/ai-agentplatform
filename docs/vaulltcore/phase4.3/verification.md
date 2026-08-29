# Phase 4.3 — Verification

## Status: IMPLEMENTED

The verification step runs after all tasks in a run complete successfully. It is triggered in `DurableWorkflowRuntime.executeRun()` after the task execution loop finishes.

## Flow

1. All tasks complete → `executeRun` re-fetches the run.
2. Transition run to `verifying` state.
3. Call `runVerification(verifiedRun)`:
   - If `verifier` or `sandboxSupplier` is absent: returns `undefined` (no-op verification, run proceeds to `completed`).
   - If both present: provisions a sandbox via `sandboxSupplier(runId, tenantId)`, collects task outcomes, calls `verifier.verify(ctx, [])`.
   - If task outcomes are empty: returns `{ passed: false }` (verification failure).
   - If verifier throws: returns `{ passed: false }` with `verifier-error` evidence.
   - Sandbox `stop()` is called in a `finally` block; stop failures are caught.
4. If verification result `passed: false`: transition to `failed` with reason `verification_failed`.
5. If verification passes (or is not configured): transition to `completed`.

## VerificationContext

The context passed to `verifier.verify()` includes:
- `workingDirectory`: sandbox's working directory or `/workspace`.
- `outcome`: first task outcome (taskId, status, success, attempts).
- `requirements`: empty array (future: populated from task spec).
- `sandbox`: the provisioned sandbox instance.

## Tests

- **Status: IMPLEMENTED** (`packages/workflow/runtime.chaos.test.ts`)
- Passing verifier → run transitions to `completed`.
- Failing verifier → run transitions to `failed`.
- Throwing verifier → run transitions to `failed`.
- Bad sandbox stop → run still completes (best-effort cleanup).
