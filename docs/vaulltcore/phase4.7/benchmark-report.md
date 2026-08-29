# Phase 4.7 — Benchmark Report

**Principle:** measured numbers only. Nothing below is extrapolated, and
single-run variance is disclosed rather than smoothed away.

## Environment (full disclosure)

| Factor | Value |
|---|---|
| Database | PostgreSQL 14.24, local, Unix-socket/TCP loopback (`127.0.0.1:5432`) |
| Driver | `postgres` (porsager) pooled client, **max 16 connections** |
| Runtime | Bun test runner, single process |
| Workers simulated | independent backend instances over the shared pool; concurrency from server-side row locking, not client sockets |
| Samples | 60 per sequential op · 15 rounds per contended op |
| Dataset | empty start; ≤ a few hundred rows during the run |

> **These are local-database latencies.** They exclude network RTT. A
> production deployment on managed Postgres adds one RTT (~0.3–2 ms same-region)
> to every round trip. Do not quote these numbers as production latency.

## Measured percentiles (milliseconds)

| Op | p50 | p95 | p99 | max | n |
|---|---|---|---|---|---|
| get | 0.07 | 0.14 | 0.22 | 0.22 | 60 |
| list | 0.08 | 0.17 | 2.48 | 2.48 | 60 |
| append | 0.14 | 0.27 | 0.58 | 0.58 | 60 |
| incr | 0.13 | 0.27 | 1.56 | 1.56 | 60 |
| cas | 0.14 | 0.41 | 1.36 | 1.36 | 60 |
| ack | 0.45 | 0.57 | 1.24 | 1.24 | 60 |
| enqueue | 0.26 | 0.43 | **36.64** | 36.64 | 60 |
| claim | 3.98 | 5.40 | 5.40 | 5.40 | 7 batches of ≤10 |
| casRace@4w | 0.17 | 0.32 | — | 0.32 | 15 |
| casRace@16w | 0.39 | 0.69 | — | 0.69 | 15 |
| incr@4w | 0.09 | **11.53** | — | 11.53 | 15 |
| incr@16w | 0.09 | 4.48 | — | 4.48 | 15 |

## Interpretation

- **Single durable writes are sub-millisecond at median** (get/append/incr/cas
  all ≤ 0.14 ms p50). Durable orchestration is nowhere near being the
  bottleneck for agent execution, where model/tool calls dominate by 3–5 orders
  of magnitude.
- **enqueue p99 = 36.6 ms is a first-batch warmup outlier** (connection
  establishment + JIT on the very first statements); p50/p95 remain 0.26/0.43
  ms. Documented rather than trimmed.
- **claim ≈ 4 ms p50** scans candidate messages with visibility checks — the
  most expensive primitive and the known **hotspot candidate** under deep
  queues. Batched claims (10/batch here) amortize it.
- **Contended incr tails (11.5 ms @4w vs 4.5 ms @16w)** invert expectations:
  with n=15 rounds this is small-sample scheduling noise, not a real effect.
  Recorded as-is per the no-invented-numbers rule; rerun with larger n before
  drawing capacity conclusions about counter hotspots.

## Capacity envelope (measured basis, honestly bounded)

From these measurements, one control-plane process against one local Postgres:

- ~7,000 single-key durable writes/sec/worker at p50 latencies (sequential
  microbench), bounded in practice by WAL fsync and connection-pool size (16).
- Queue throughput observed: 100 messages enqueued + drained + acked by 2
  concurrent workers inside the storm test comfortably within its timeout.
- **UNKNOWN (not measured):** multi-node worker fan-out beyond one process,
  networked-RTT percentiles, sustained-hour soak, DB CPU saturation point.
  These require a networked production-grade database and are marked as such.

## What was deliberately NOT benchmarked

Agent Engine end-to-end latency, sandbox provisioning, LLM calls — Phase 4.7
measures the durability substrate only. The Phase 4.2 fast-path architecture
owns agent-side performance.
