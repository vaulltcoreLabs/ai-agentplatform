# Vaulltcore Phase 4.4 — Forensic Audit (verified)

**Method:** every finding below was checked against the actual code at/after
commit `95ee43a`. Claims that could not be verified are marked as such.

---

## 0. Corrections to the prior draft of this document

The previous version of this file asserted findings that the code refutes.
They are retracted and corrected here:

| Prior claim | Verdict | Evidence |
|---|---|---|
| "Idempotency key ignored on job creation; `saveJob` discards it" | **FALSE** | `runtime.ts` `submit()` checks `idempotency.get()` before creating a run, records the key after completion, and passes it to `saveJob`; `stores.ts saveJob()` honors `opts.idempotencyKey` via `idempotencyIndex` |
| "Checkpoints never persisted (`void checkpoint;`)" | **FALSE** | `scheduler.ts:415`: `await this.store.saveCheckpoint(checkpoint)` |
| "`authorize()` never called at entry points" | **FALSE** | `cancel()`, `getJob()`, `streamEvents()` call `assertAuthorized`; distributed runtime gates `submit()` with `assertTenantKnown` + `assertAuthorized` |
| "`GITHUB_EGRESS_NETWORK` contains `"*"` defeating deny-by-default" | **FALSE** | `sandbox/security.ts:88-95`: explicit host list, no wildcard; `"*"` exists only in `ALLOW_ALL_NETWORK`, a documented legacy opt-in |
| "`EngineSpecialistRunner.resolveSpec` always returns undefined" | **FALSE** | `orchestrator.ts:202-209`: registry lookup with `coder` fallback for `default`/`executor` |
| "Tenant quota checks never invoked" | **FALSE** | `runtime.submit()` calls `canStartRun`, then `incrementRuns`/`decrementRuns` around execution |
| "Chaos 'crash' calls `this.terminate()`" | **FALSE** | `chaos.ts` throws `CrashError` *without* releasing the lease — modelling process death correctly at the durable-state level |
| "`evaluateTaskCompletion` always `{complete:false}`" | **FALSE** | Implemented; reads real task status |
| "2 agent failures caused by `ai@6.0.194` tool import" | **MISDIAGNOSED** | SDK exports `tool` fine (verified by direct runtime import). Cause: `mock.module("ai")` in `models.test.ts` polluting Bun's process-wide module registry. Fixed this phase |

## 1. Genuine weaknesses found (and status)

### W1 — SandboxSecurityPolicy accepted but enforced nowhere (P0) — FIXED
`SandboxStepExecutorOptions.securityPolicy` was stored and never consulted;
neither Docker nor Vercel sandbox implementations nor any agent tool called
`checkCommand` / `confinePath` / `isPathDenied` / `checkHost`. The policy layer
was pure theater: tested in isolation, wired to nothing.

**Fix:** `packages/sandbox/policy-enforcement.ts` provides
`enforceSecurityPolicy(sandbox, policy)`; `AgentSandboxContext` now carries an
optional `securityPolicy`; agent tools' `getSandbox()` wraps every live sandbox
(tools reconnect from serialized state via `connectSandbox`, so wrapping a
local instance would have been ineffective — this was caught during review).
Enforced operations: all reads/stats/mkdir/readdir (confinement + denied
paths), writes (confinement + size ceiling), exec/execDetached (command policy
+ cwd confinement).

**Remaining boundary:** network egress cannot be proven from a command string.
The host allowlist is contractual until providers enforce it at socket level
(see `security-audit.md`).

### W2 — Command denylist whitespace evasion (P1) — FIXED
`checkCommand` used raw substring matching, so `":(){ :|:& };:"` evaded
`":(){:|:&};:"`. Matching now normalizes whitespace, and the default policy
gains `rm -fr /`, `rm -r -f /`, `rm -f -r /`.

### W3 — Agent suite silently under-running (P2) — FIXED
Because two files failed to load, ~27 tests never executed and were invisible
as failures. Suite now runs 74 tests, 74 pass.

## 2. What is genuinely solid (verified)

- Deterministic, tenant-salted content-addressed IDs (`identity.ts`)
- CAS on steps/tasks/runs with lease-version + step-version double fencing
  (`scheduler.completeStep`), crash recovery via expired-lease reset
- Durable cancellation markers observed by workers on every poll cycle
- Idempotent submit end-to-end in both single-process and distributed runtimes
- Reconciliation loop that re-enqueues active runs from store truth
- Event redaction (`redactDurableEvent`) on every external read path
- Budget checks per task loop + deadline propagation into step abort signals

## 3. Honest limits (unchanged)

See `distributed-audit.md` and `acceptance-report.md`. Headlines:
persistence is in-memory only; multi-process correctness is exercised only
in-process; there are zero performance benchmarks, therefore **no 10× claim is
made or supportable**.
