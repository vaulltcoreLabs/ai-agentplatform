# Phase 4.4 — Acceptance Report

Statuses: IMPLEMENTED / DISTRIBUTED / CONTRACTUAL / FUTURE.
"DISTRIBUTED" is reserved for guarantees proven against a networked backend —
none qualify yet.

| Capability | Current implementation | Evidence | Status | Risk | Required action |
|---|---|---|---|---|---|
| Agent execution (tool loop, subagents) | ToolLoopAgent via provider-neutral gateway | `open-agent.ts`, engine tests | IMPLEMENTED | low | — |
| Sandbox execution wiring | `SandboxStepExecutor` bridges durable steps → sandbox → agent | workflow tests | IMPLEMENTED | low | — |
| Security policy enforcement | enforced at tool I/O when policy attached | policy-enforcement + 3 test layers | IMPLEMENTED | medium | make policy mandatory per deployment |
| Network egress deny-by-default | policy data + correct `checkHost`; no socket enforcement | security.ts; no provider hook | CONTRACTUAL | high | provider-level egress control |
| Command policy | denylist w/ normalized matching; allowlist mode | security.ts, adversarial tests | IMPLEMENTED | low | — |
| Filesystem policy | confinement + secret denial + size ceiling at API boundary | policy-enforcement tests | IMPLEMENTED | low | symlink semantics inside providers |
| Resource limits | deadline→abort implemented; CPU/mem delegated to providers | runtime, providers | PARTIAL/CONTRACTUAL | medium | explicit cgroup config |
| Idempotent submission | atomic idempotency in both runtimes | runtime.ts, distributed-runtime.ts | IMPLEMENTED | low | — |
| CAS + fencing | double fence (lease+step version) before commits | scheduler.completeStep | IMPLEMENTED (in-memory) | medium | adapter conformance suite |
| Leases & crash recovery | TTL leases; expired-lease reset on release | leases.ts, releaseSteps | IMPLEMENTED (in-memory) | medium | same |
| Reconciliation | store-truth re-enqueue loop | distributed-runtime.reconcile | IMPLEMENTED (design) | low | run it in production cadence |
| Durable cancellation | persisted marker polled by workers | cancellation.ts, worker.ts | IMPLEMENTED mechanism | low | shared-store adapter |
| Checkpoints | saved per completed step; resume-from-checkpoint absent | scheduler.checkpointCompletedStep | PARTIAL/FUTURE | medium | implement replay/resume |
| Budgets | per-task-loop checks + usage accumulation; deadline abort bounds within-task overrun | runtime.executeRun | IMPLEMENTED (coarse) | medium | mid-step budget signals from executor |
| Tenant quotas | submit-time concurrency quotas | tenant.ts usage in runtime | IMPLEMENTED (in-process) | medium | shared meter for multi-process |
| Tenant authorization | gates at cancel/getJob/stream/submit | authorization.ts call sites | IMPLEMENTED | low | keep all access behind runtime |
| Event ordering/redaction | monotonic per-run sequence; redacted externally | stores, security.ts | IMPLEMENTED (in-memory) | low | durable event store |
| Production persistence | none — in-memory only | stores.ts header | FUTURE | high | build Postgres/etc. adapters |
| Distributed correctness proof | exercised only in one process | distributed.test.ts | CONTRACTUAL | high | multi-process integration harness |
| Organizational memory | tenant-scoped interfaces; NoopMemory default | memory.ts | CONTRACTUAL | low | wire real backend before any claims |
| Plan/context caches, speculation | not present in codebase | — | FUTURE | — | design with revision-aware fingerprints |
| Performance benchmarks | none exist | — | FUTURE | — | see benchmark-plan.md |

## Final decision: PASS WITH CONDITIONS

The implementation honestly satisfies what it claims after this phase's
hardening: the security policy is now real at the tool boundary, the command
denylist resists trivial evasion, the full agent suite runs green, and every
durability claim is labeled truthfully. No false "distributed", "exactly-once",
or performance claims remain in the documentation.

**Gates that must close before production claims upgrade:**

1. **G1 — Persistence adapter:** a networked WorkflowStore passing the same
   contract suite (unblocks DISTRIBUTED labels).
2. **G2 — Multi-process harness:** two independent processes against the
   shared backend running the existing failure-injection matrix
   (dup messages, lost acks, lease takeover, cancellation races).
3. **G3 — Provider-level egress enforcement:** network policy moves from
   CONTRACTUAL to IMPLEMENTED only when enforced below the command layer.
4. **G4 — Mandatory security policy:** deployments must attach a policy;
   optional attachment remains a footgun for future integrations.
5. **G5 — Benchmarks:** any speed/cost claim requires the harness in
   `benchmark-plan.md`. Until then, Vaulltcore claims zero performance
   advantages over a generic agent.
