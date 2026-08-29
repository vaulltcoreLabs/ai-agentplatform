# Phase 4.4 — Distributed Audit

Verdict per guarantee, using the required vocabulary. The decisive question
for every row: *would this stay correct with two independent processes against
a real networked backend?*

| Guarantee | Status | Evidence & caveats |
|---|---|---|
| Deterministic tenant-scoped IDs | IMPLEMENTED | `identity.ts` (sha256, tenant salt) |
| CAS on run/task/step writes | IMPLEMENTED (in-memory) | version-checked saves in `stores.ts`; contract documented for adapters |
| Lease claim/renew/revoke | IMPLEMENTED (in-memory) | `leases.ts`, TTL + heartbeat fields |
| Fencing (lease version + step version) | IMPLEMENTED | `scheduler.completeStep` double-fence before any durable write |
| Lease expiry → crash recovery | IMPLEMENTED | `releaseSteps` resets running/waiting steps whose lease is gone/expired |
| Duplicate queue messages | CONTRACTUAL | `InMemoryQueue` dedups messageId; real-queue semantics depend on adapter |
| Lost messages / reconciliation | IMPLEMENTED (design) + CONTRACTUAL (transport) | `reconcile()` re-enqueues active runs from store truth; idempotent enqueue |
| Idempotent submission | IMPLEMENTED | both runtimes; atomic check via shared IdempotencyStore |
| Idempotent task completion | IMPLEMENTED | fenced commit; duplicate commits rejected by lease/version checks |
| Retry semantics | IMPLEMENTED | classified retryable failures, deterministic step ids per attempt, bounded (`attempt <= 5`) |
| Cancellation, cross-process | IMPLEMENTED (mechanism), CONTRACTUAL (transport) | durable marker written by cancel(), polled by every worker cycle; needs shared store to be multi-process |
| Checkpointing | IMPLEMENTED (in-memory) | saved on every completed step; recovery *resume-from-checkpoint* not implemented (FUTURE) |
| Event ordering / monotonic sequences | IMPLEMENTED (in-memory) | per-run sequence in event store; adapter must preserve |
| Event durability | CONTRACTUAL | in-memory only |
| Budget enforcement during execution | IMPLEMENTED (coarse) | checked each task loop; usage accumulated from step results. Within-task overruns are bounded only by the deadline abort — flagged P2 |
| Tenant quotas | IMPLEMENTED (in-process) | concurrency quotas enforced at submit; shared metering needed for multi-process (CONTRACTUAL) |
| Deadline propagation | IMPLEMENTED | run deadline → step childSignal → executor AbortSignal → sandbox exec signal |
| Failure classification | IMPLEMENTED | taxonomy mapped across intelligence→durable layers |
| Worker isolation on simulated crash | IMPLEMENTED | CrashError leaves lease intact for takeover |
| Production persistence | **FUTURE** | all stores are in-memory; adapters are the documented extension point |
| Exactly-once side effects | **NOT CLAIMED** | model is at-least-once execution + idempotency keys + fenced commits; external side effects (git push, API calls) are the executor's responsibility and currently unguarded |

## Bottom line

The substrate's *contracts* and its single-process implementation are strong
and well-tested (218 workflow tests). Nothing here has yet run against a
networked backend, so every "distributed" property is correctly labeled
CONTRACTUAL until a Postgres/Redis-backed adapter exists and passes the same
test matrix. The in-memory backend is a faithful reference implementation of
the contracts, not proof of distributed correctness.
