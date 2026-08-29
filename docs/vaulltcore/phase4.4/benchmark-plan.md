# Phase 4.4 — Benchmark Plan

## Current state (honest)

**No performance benchmarks exist in this repository.** There are no latency
measurements, token counts, model-call counts, or sandbox startup timings
tracked anywhere. Consequently:

- No "10× faster" claim is made, and none is supportable.
- Any prior document implying measured acceleration was aspirational, not
  empirical.

## Why measure before optimizing

The plausible dominant terms for time-to-correct-result are, in expected order:

1. **Model latency** — every planning/execution/verification model call
2. **Sandbox provisioning** — Vercel MicroVM (~5–15 s) / Docker (~2–5 s),
   currently per-step with no reuse
3. **Verification** — tests + typecheck + lint run sequentially in-sandbox
4. **Tool latency** — file/shell operations
5. **Workflow overhead** — store writes, lease ops, event appends (µs–ms,
   likely negligible today)

Nothing can be claimed about speed until 1–3 are measured against a fixed
workload.

## Proposed deterministic harness

- **Executor:** a scripted fake agent returning canned outputs with recorded
  call counts; a controllable clock (`TestClock` already exists) for deadline/
  retry timing. No network, no sleeps.
- **Workloads:** single-file edit · bug fix · multi-file feature · DAG of N
  independent tasks (parallel vs sequential).
- **Metrics recorded per run:** wall time, p50/p95/p99 over ≥100 iterations,
  model calls, tool calls, sandbox provisions, verification runs, retries,
  budget units consumed.
- **Comparisons that would matter once caches/speculation exist:** cold vs
  warm vs cache-hit paths, and regression guards asserting cache-hit overhead
  stays under a fixed budget (e.g. <1 ms p95).

## Acceptance criteria for any future performance claim

1. Harness committed and runnable via a package script.
2. Baseline numbers checked into `docs/` with commit hash and environment.
3. Claimed improvement reproduced by the harness in CI with a regression guard.
4. In-memory results explicitly labeled as such; distributed numbers require
   the multi-process harness from `acceptance-report.md` gate G2.
