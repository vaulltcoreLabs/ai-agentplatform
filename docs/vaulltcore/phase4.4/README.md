# Vaulltcore Phase 4.4 — Forensic Audit & Hardening (Final)

**Date:** 2026-08-24 · **Baseline commit:** `95ee43a` · **Status:** hardening implemented and verified

---

## What this phase actually did

Phase 4.4 was a forensic audit of the real repository state followed by targeted
hardening. Every claim below was verified against code, not inherited from prior
phase summaries. An earlier draft of `forensic-audit.md` in this directory
contained findings that **did not match the code**; those have been purged and
replaced with verified evidence (see `forensic-audit.md`, "Corrections to prior
draft").

## Verified baseline (before this session's changes)

| Suite | Result |
|---|---|
| workflow | 216 pass / 0 fail |
| intelligence | 108 pass / 0 fail |
| sandbox | 92 pass / 0 fail |
| agent | 46 pass + 2 load errors, **misdiagnosed** as `ai@6.0.194` |

The two "known pre-existing failures caused by `ai@6.0.194` tool import
behavior" were **independently verified and refuted**: the SDK exports `tool`
correctly at runtime. The real cause was `mock.module("ai", ...)` in
`packages/agent/models.test.ts` replacing the module registry process-wide under
Bun's single-process runner, breaking later-loaded files that import `tool`.
Fixed by spreading the real namespace into the mock.

## Hardening implemented in this phase

1. **Sandbox security policy is now enforced at the tool I/O boundary** (was:
   accepted but ignored everywhere). New `enforceSecurityPolicy` decorator
   (`packages/sandbox/policy-enforcement.ts`) wraps any live sandbox; wired via
   `AgentSandboxContext.securityPolicy` → `getSandbox()` in the agent tools,
   the single choke point all tools use.
2. **Command-denylist evasion closed** (`packages/sandbox/security.ts`):
   whitespace normalization plus additional `rm -r -f` variants; previously
   `":(){ :|:& };:"` evaded the fork-bomb pattern by spacing alone.
3. **Test-pollution fix** in `models.test.ts` and prophylactically in
   `tools/utils.test.ts` (partial mock → full-namespace mock).

## Final verified state (after hardening)

| Check | Result |
|---|---|
| workflow tests | 218 pass / 0 fail (+2 policy-wiring) |
| intelligence tests | 108 pass / 0 fail |
| sandbox tests | 105 pass / 0 fail (+13 adversarial) |
| agent tests | 74 pass / 0 fail (**was 46+2 errors**; erroring files now load) |
| typecheck | pass for agent, intelligence, sandbox, workflow, web |
| lint/format (`pnpm check`) | 0 warnings, 0 errors |

## Documents

| Document | Contents |
|---|---|
| `forensic-audit.md` | Verified findings with file:line evidence; explicit corrections of the false prior claims |
| `security-audit.md` | Sandbox/tenant security posture: what is enforced vs contractual |
| `distributed-audit.md` | IMPLEMENTED vs CONTRACTUAL/FUTURE for every durability guarantee |
| `hardening-report.md` | Before/after per change, files touched, verification log |
| `acceptance-report.md` | Capability × status × risk matrix and final decision |
| `benchmark-plan.md` | Honest performance posture: no benchmarks exist; how to build them |

## Final decision

**PASS WITH CONDITIONS** — details and gates in `acceptance-report.md`.
