# Phase 4.1 — Capacity Model

## Throughput

- `DistributedQueue` is a single ordered work list per backend; `claim(n)`
  returns up to `n` messages whose visibility timeout has elapsed.
- `DurableWorker.processOne` claims **1** message and returns **1** runnable
  step per poll (single-authoritative release).
- Throughput ≈ `W workers × (1 poll / P poll_interval)`, where `P` is bounded
  by queue-claim latency (no busy-wait when idle: `stopWhenIdle` exits).
- Fan-out across independent DAG tasks happens across polls/workers; dependent
  tasks wait for parents.

## Latency

- Step commit latency = execute + checkpoint + fenced `saveStep` CAS.
- Run finalize latency = max step completion + one extra poll to observe all
  terminal (two-phase `verifying`).

## Sizing knobs

| Knob | Default | Tuned via |
| --- | --- | --- |
| Lease TTL | `DEFAULT_LEASE_CONFIG` (sane default) | `leaseConfig` on `DurableScheduler` |
| Queue visibility timeout | 30_000 ms | `queue.claim(worker, max, visibilityTimeoutMs)` |
| Retry delay | 50 ms | `queue.retry(messageId, delayMs)` |
| Budget | per-run `PlanBudget` | `guardBudget` / `RunUsage` |

## Scaling dimensions (Cloudflare)

- **Horizontal (runs)**: independent runs partition across backend instances /
  Durable Objects. No global lock.
- **Horizontal (workers)**: N workers polling the same queue; leases serialize
  per step.
- **Vertical**: larger poll batch size (currently capped at 1 for simplicity);
  can be raised to `maxMessages` once multi-step release is justified.
- **Hot key**: a single run with many fine-grained steps contends on that
  run's task list; mitigated by single-authoritative release (one step per poll
  reduces contention vs. bulk-claim-and-storm).
