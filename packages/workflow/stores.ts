/**
 * Vaulltcore Durable Execution — deterministic in-memory store implementations.
 *
 * These provide a fully functional, provider-neutral runtime with no external
 * dependencies. They exist so tests run deterministically under `bun test` and
 * so local development works without database provisioning.
 *
 * Production deployments supply provider-specific adapters implementing the
 * same contracts. Each contract documents the consistency guarantee it
 * provides so an adapter can be evaluated independently.
 */
/* eslint-disable max-classes-per-file */

import type {
  Checkpoint,
  DurableEvent,
  DurableTransition,
  Job,
  Lease,
  Run,
  RunUsage,
  Step,
  Task,
} from "./model";
import type { RunStatus } from "./status";
import { createLeaseId } from "./identity";
import type { DurableRunId } from "./identity";
import { isTerminal, runCanTransition } from "./status";
import type {
  CheckpointStore,
  Clock,
  EventStore,
  IdempotencyRecord,
  IdempotencyStore,
  Queue,
  QueueStats,
  QueuedMessage,
  TaskLeaseStore,
  WorkflowStore,
} from "./contracts";

export { TestClock, SystemClock } from "./clock";
export type { Clock } from "./contracts";

/**
 * In-memory implementation of `WorkflowStore`. All CAS operations are
 * enforced with in-process object identity + version checks.
 *
 * Single-process only. A real deployment uses a multi-process store (e.g.
 * Postgres) that provides the same atomicity guarantees.
 */
export class InMemoryWorkflowStore implements WorkflowStore {
  private readonly jobs = new Map<string, Job>();
  private readonly runs = new Map<string, Run>();
  private readonly runsByJob = new Map<string, Run[]>();
  private readonly runByVersion = new Map<string, Map<number, Run>>();
  private readonly tasks = new Map<string, Task>();
  private readonly steps = new Map<string, Step>();
  private readonly checkpoints = new Map<string, Checkpoint[]>();
  private readonly transitions: DurableTransition[] = [];
  private readonly jobIndex = new Map<string, string>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly cancellationMarkers = new Map<
    string,
    { requestedBy: string; reason: string; requestedAt: number }
  >();
  private readonly runUsage = new Map<string, RunUsage>();
  private jobVersion = 0;

  constructor(private readonly clock: Clock) {}

  async saveJob(
    job: Job,
    opts?: { idempotencyKey?: string },
  ): Promise<boolean> {
    const key = `${job.tenantId}:${job.id}`;
    if (opts?.idempotencyKey) {
      const existingId = this.idempotencyIndex.get(opts.idempotencyKey);
      if (existingId !== undefined && existingId !== job.id) {
        return false;
      }
    }
    const existing = this.jobs.get(key);
    if (existing && existing.version >= job.version) {
      return false;
    }
    this.jobs.set(key, job);
    this.jobIndex.set(job.id, key);
    if (opts?.idempotencyKey) {
      this.idempotencyIndex.set(opts.idempotencyKey, job.id);
    }
    return true;
  }

  async getJob(tenantId: string, jobId: string): Promise<Job | undefined> {
    return this.jobs.get(`${tenantId}:${jobId}`);
  }

  async resolveJobTenant(jobId: string): Promise<string | undefined> {
    for (const [key, job] of this.jobs) {
      if (job.id === jobId) {
        return key.split(":")[0];
      }
    }
    return undefined;
  }

  async claimJob(jobId: string, _worker: string): Promise<boolean> {
    const key = this.jobIndex.get(jobId);
    if (!key) return false;
    const job = this.jobs.get(key);
    if (!job) return false;
    const updated: Job = { ...job, status: "running" };
    this.jobs.set(key, updated);
    return true;
  }

  async saveRun(
    run: Run,
    _opts?: { idempotencyKey?: string },
  ): Promise<boolean> {
    const existing = this.runs.get(run.id);
    if (existing && existing.version > run.version) {
      return false;
    }
    this.runs.set(run.id, run);
    let byJob = this.runsByJob.get(run.jobId);
    if (!byJob) {
      byJob = [];
      this.runsByJob.set(run.jobId, byJob);
    }
    // Replace if already present (upsert)
    const idx = byJob.findIndex((r) => r.id === run.id);
    if (idx >= 0) {
      byJob[idx] = run;
    } else {
      byJob.push(run);
    }
    let versions = this.runByVersion.get(run.jobId);
    if (!versions) {
      versions = new Map();
      this.runByVersion.set(run.jobId, versions);
    }
    versions.set(run.version, run);
    return true;
  }

  async getRun(runId: string): Promise<Run | undefined> {
    return this.runs.get(runId);
  }

  async listActiveRunIds(_tenantId?: string): Promise<readonly DurableRunId[]> {
    const out: DurableRunId[] = [];
    for (const run of this.runs.values()) {
      if (!isTerminal(run.status)) out.push(run.id as DurableRunId);
    }
    return out;
  }

  async getRunByJobAndVersion(
    jobId: string,
    version: number,
  ): Promise<Run | undefined> {
    const versions = this.runByVersion.get(jobId);
    if (!versions) return undefined;
    return versions.get(version);
  }

  async transitionRun(
    runId: string,
    from: RunStatus,
    to: RunStatus,
    opts: {
      expectedVersion: number;
      actor: string;
      source: string;
      reason?: string;
      correlationId?: string;
      idempotencyKey?: string;
    },
  ): Promise<DurableTransition | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.version !== opts.expectedVersion) {
      return null;
    }
    if (run.status !== from) {
      return null;
    }
    if (!runCanTransition(from, to)) {
      return null;
    }
    const terminal = isTerminal(to);
    const updated: Run = {
      ...run,
      status: to,
      version: run.version + 1,
      endedAt: terminal ? this.clock.now() : run.endedAt,
      reason: opts.reason ?? run.reason,
    };
    this.runs.set(runId, updated);

    const transition: DurableTransition = {
      resource: "run",
      resourceId: runId,
      from,
      to,
      actor: opts.actor,
      source: opts.source,
      timestamp: this.clock.now(),
      correlationId: opts.correlationId ?? "",
      idempotencyKey: opts.idempotencyKey,
      version: updated.version,
      reason: opts.reason,
    };
    this.transitions.push(transition);
    return transition;
  }

  async saveTask(taskId: string, task: Task): Promise<boolean> {
    const existing = this.tasks.get(taskId);
    if (existing && existing.version > task.version) {
      return false;
    }
    this.tasks.set(taskId, task);
    return true;
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return this.tasks.get(taskId);
  }

  async saveStep(step: Step, expectedVersion: number): Promise<boolean> {
    const existing = this.steps.get(step.id);
    if (!existing) {
      if (expectedVersion !== 0) return false;
      this.steps.set(step.id, step);
      return true;
    }
    if (existing.version !== expectedVersion) return false;
    if (step.version <= existing.version) return false;
    this.steps.set(step.id, step);
    return true;
  }

  async getStep(stepId: string): Promise<Step | undefined> {
    return this.steps.get(stepId);
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<boolean> {
    let list = this.checkpoints.get(checkpoint.stepId);
    if (!list) {
      list = [];
      this.checkpoints.set(checkpoint.stepId, list);
    }
    list.push(checkpoint);
    list.sort((a, b) => a.sequence - b.sequence);
    return true;
  }

  async recordTransition(transition: DurableTransition): Promise<void> {
    this.transitions.push(transition);
  }

  async getTransitions(
    resource: string,
    since = 0,
  ): Promise<DurableTransition[]> {
    return this.transitions.filter(
      (t) => t.resource === resource && t.timestamp >= since,
    );
  }

  async setCancellationMarker(
    runId: string,
    _tenantId: string,
    requestedBy: string,
    reason: string,
    requestedAt: number,
  ): Promise<void> {
    this.cancellationMarkers.set(runId, { requestedBy, reason, requestedAt });
  }

  async getCancellationMarker(
    runId: string,
  ): Promise<
    { requestedBy: string; reason: string; requestedAt: number } | undefined
  > {
    return this.cancellationMarkers.get(runId);
  }

  async getRunUsage(runId: string): Promise<RunUsage | undefined> {
    return this.runUsage.get(runId);
  }

  async addRunUsage(
    runId: string,
    delta: Partial<RunUsage>,
    _startedAt: number,
  ): Promise<boolean> {
    const base: RunUsage = this.runUsage.get(runId) ?? {
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      executionMs: 0,
    };
    this.runUsage.set(runId, {
      modelCalls: base.modelCalls + (delta.modelCalls ?? 0),
      toolCalls: base.toolCalls + (delta.toolCalls ?? 0),
      inputTokens: base.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: base.outputTokens + (delta.outputTokens ?? 0),
      executionMs: base.executionMs + (delta.executionMs ?? 0),
    });
    return true;
  }

  /** Internal: bump the job's version and persist. */
  async bumpJobVersion(jobId: string): Promise<number> {
    const key = this.jobIndex.get(jobId);
    if (!key) return 0;
    const job = this.jobs.get(key);
    if (!job) return 0;
    this.jobVersion = job.version + 1;
    const updated: Job = {
      ...job,
      version: this.jobVersion,
      updatedAt: this.clock.now(),
    };
    this.jobs.set(key, updated);
    return this.jobVersion;
  }
}

/**
 * In-memory lease store implementing CAS-based claim / revoke / renew.
 */
export class InMemoryTaskLeaseStore implements TaskLeaseStore {
  private readonly leases = new Map<string, Lease>();

  constructor(private readonly clock: Clock) {}

  async claim(
    stepId: string,
    owner: string,
    ttlMs: number,
  ): Promise<Lease | null> {
    const existing = this.leases.get(stepId);
    if (existing) {
      if (existing.expiresAt > this.clock.now()) {
        return null;
      }
    }
    const now = this.clock.now();
    const lease: Lease = {
      id: createLeaseId(),
      stepId,
      owner,
      attempt: existing ? existing.attempt + 1 : 1,
      expiresAt: now + ttlMs,
      heartbeatAt: now,
      version: existing ? existing.version + 1 : 1,
      createdAt: now,
      revokedAt: null,
    };
    this.leases.set(stepId, lease);
    return lease;
  }

  async renew(leaseId: string, owner: string, ttlMs: number): Promise<boolean> {
    for (const [stepId, lease] of this.leases) {
      if (lease.id === leaseId && lease.owner === owner) {
        const now = this.clock.now();
        if (lease.expiresAt <= now) {
          return false;
        }
        const renewed: Lease = {
          ...lease,
          expiresAt: now + ttlMs,
          heartbeatAt: now,
          version: lease.version + 1,
        };
        this.leases.set(stepId, renewed);
        return true;
      }
    }
    return false;
  }

  async revoke(leaseId: string, owner: string): Promise<void> {
    for (const [stepId, lease] of this.leases) {
      if (lease.id === leaseId && lease.owner === owner) {
        this.leases.delete(stepId);
        return;
      }
    }
  }

  async getLease(stepId: string): Promise<Lease | null> {
    return this.leases.get(stepId) ?? null;
  }

  async getLeasesForWorker(owner: string): Promise<Lease[]> {
    return [...this.leases.values()].filter((l) => l.owner === owner);
  }

  async getExpiredLeases(now: number): Promise<Lease[]> {
    return [...this.leases.values()].filter((l) => l.expiresAt <= now);
  }
}

/**
 * Append-only in-memory event store with per-run monotonic sequencing
 * and idempotency-key dedup.
 */
export class InMemoryEventStore implements EventStore {
  private readonly runs = new Map<string, DurableEvent[]>();
  private readonly sequences = new Map<string, number>();
  private readonly dedup = new Map<string, DurableEvent>();

  constructor(private readonly clock: Clock) {}

  async append(
    event: Omit<DurableEvent, "eventId" | "sequence" | "timestamp"> & {
      readonly idempotencyKey?: string;
    },
  ): Promise<DurableEvent> {
    if (event.idempotencyKey && this.dedup.has(event.idempotencyKey)) {
      return this.dedup.get(event.idempotencyKey)!;
    }
    const seq = (this.sequences.get(event.runId) ?? 0) + 1;
    this.sequences.set(event.runId, seq);
    const durable: DurableEvent = {
      ...event,
      sequence: seq,
      timestamp: this.clock.now(),
      eventId: `${event.runId}:evt:${seq}`,
    };
    let events = this.runs.get(event.runId);
    if (!events) {
      events = [];
      this.runs.set(event.runId, events);
    }
    events.push(durable);
    if (event.idempotencyKey) {
      this.dedup.set(event.idempotencyKey, durable);
    }
    return durable;
  }

  async replay(runId: string, fromSequence = 0): Promise<DurableEvent[]> {
    return (this.runs.get(runId) ?? []).filter(
      (e) => e.sequence >= fromSequence,
    );
  }

  count(runId: string): number {
    return this.sequences.get(runId) ?? 0;
  }
}

/**
 * Append-only in-memory checkpoint store keyed by step + sequence.
 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, Checkpoint[]>();

  async save(checkpoint: Checkpoint): Promise<boolean> {
    let list = this.checkpoints.get(checkpoint.stepId);
    if (!list) {
      list = [];
      this.checkpoints.set(checkpoint.stepId, list);
    }
    list.push(checkpoint);
    list.sort((a, b) => a.sequence - b.sequence);
    return true;
  }

  async listForStep(stepId: string): Promise<Checkpoint[]> {
    return [...(this.checkpoints.get(stepId) ?? [])];
  }

  async latestForStep(stepId: string): Promise<Checkpoint | null> {
    const list = this.checkpoints.get(stepId);
    if (!list || list.length === 0) return null;
    return list[list.length - 1] ?? null;
  }

  count(): number {
    let total = 0;
    for (const list of this.checkpoints.values()) {
      total += list.length;
    }
    return total;
  }
}

/**
 * In-memory idempotency store.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async record(
    key: string,
    operation: string,
    result: unknown,
  ): Promise<"recorded" | "duplicate" | "conflict"> {
    if (this.records.has(key)) {
      const existing = this.records.get(key)!;
      if (existing.operation === operation) {
        return "duplicate";
      }
      return "conflict";
    }
    this.records.set(key, {
      key,
      operation,
      result,
      recordedAt: Date.now(),
    });
    return "recorded";
  }

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    return this.records.get(key);
  }
}

/**
 * In-memory FIFO queue with visibility-timeout leasing semantics.
 */
export class InMemoryQueue implements Queue {
  /**
   * Messages indexed by composite tenant+messageId key (Phase 5 §15).
   * Cross-tenant same-ID collisions are impossible by construction.
   */
  private readonly messages: QueuedMessage[] = [];
  private readonly inflight = new Map<string, QueuedMessage>();
  private readonly deadLettered: QueuedMessage[] = [];

  private static compositeKey(tenantId: string, messageId: string): string {
    return `${tenantId}␟${messageId}`;
  }

  async enqueue(
    ref: { tenantId: string; messageId: string },
    payload: unknown,
    opts?: {
      delayMs?: number;
      priority?: number;
      idempotencyKey?: string;
    },
  ): Promise<boolean> {
    if (
      this.messages.some(
        (m) => m.tenantId === ref.tenantId && m.messageId === ref.messageId,
      )
    ) {
      return false;
    }
    const now = Date.now();
    this.messages.push({
      tenantId: ref.tenantId,
      messageId: ref.messageId,
      payload,
      priority: opts?.priority ?? 0,
      enqueuedAt: now,
      availableAt: now + (opts?.delayMs ?? 0),
      attempt: 0,
      receivedCount: 0,
    });
    this.sort();
    return true;
  }

  private sort(): void {
    this.messages.sort(
      (a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt,
    );
  }

  async claim(
    workerId: string,
    maxMessages: number,
    visibilityTimeoutMs: number,
  ): Promise<QueuedMessage[]> {
    const now = Date.now();
    const available = this.messages.filter((m) => m.availableAt <= now);
    available.sort(
      (a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt,
    );
    const claimed = available.slice(0, maxMessages);
    for (const msg of claimed) {
      const idx = this.messages.indexOf(msg);
      if (idx >= 0) {
        this.messages.splice(idx, 1);
      }
      const leased: QueuedMessage = {
        ...msg,
        attempt: msg.attempt + 1,
        receivedCount: msg.receivedCount + 1,
        availableAt: now + visibilityTimeoutMs,
      };
      this.inflight.set(
        InMemoryQueue.compositeKey(msg.tenantId, msg.messageId),
        leased,
      );
    }
    return claimed.map(
      (msg) =>
        this.inflight.get(
          InMemoryQueue.compositeKey(msg.tenantId, msg.messageId),
        ) ?? msg,
    );
  }

  async ack(
    ref: { tenantId: string; messageId: string },
    workerId: string,
  ): Promise<boolean> {
    const key = InMemoryQueue.compositeKey(ref.tenantId, ref.messageId);
    if (this.inflight.has(key)) {
      this.inflight.delete(key);
      return true;
    }
    return false;
  }

  async retry(
    ref: { tenantId: string; messageId: string },
    delayMs = 0,
  ): Promise<boolean> {
    const key = InMemoryQueue.compositeKey(ref.tenantId, ref.messageId);
    if (this.inflight.has(key)) {
      const msg = this.inflight.get(key)!;
      this.inflight.delete(key);
      const now = Date.now();
      const requeued: QueuedMessage = {
        ...msg,
        attempt: msg.attempt + 1,
        receivedCount: msg.receivedCount + 1,
        availableAt: now + delayMs,
      };
      this.messages.push(requeued);
      this.sort();
      return true;
    }
    return false;
  }

  async deadLetter(
    ref: { tenantId: string; messageId: string },
    _reason: string,
  ): Promise<boolean> {
    const key = InMemoryQueue.compositeKey(ref.tenantId, ref.messageId);
    if (this.inflight.has(key)) {
      const msg = this.inflight.get(key)!;
      this.inflight.delete(key);
      this.deadLettered.push(msg);
      return true;
    }
    return false;
  }

  async stats(): Promise<QueueStats> {
    const now = Date.now();
    return {
      visible: this.messages.filter((m) => m.availableAt <= now).length,
      inflight: this.inflight.size,
      delayed: this.messages.filter((m) => m.availableAt > now).length,
      deadLettered: this.deadLettered.length,
    };
  }
}
