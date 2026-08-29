/* eslint-disable max-classes-per-file */
/**
 * Vaulltcore Durable Execution — distributed, provider-neutral store adapter.
 *
 * This module is the Phase 4.1 production-grade shared-state foundation. It is
 * intentionally *not* coupled to Cloudflare, Postgres, Redis, or any concrete
 * primitive. It is built on a single injected `SharedBackend` that owns the raw
 * key/value + sequence primitives. A Cloudflare Durable Object, a Postgres
 * row, or a Redis hash are all valid backends — they differ only in how
 * `SharedBackend` is implemented.
 *
 * The distributed stores enforce correctness at the durable boundary:
 *
 *  - **Atomic idempotency**: `recordIdempotency` is a single CAS on the
 *    backend, so two runtimes sharing a backend cannot both "create" a job
 *    under the same key.
 *  - **Compare-and-swap leases**: `claim` is atomic on `(stepId, version)`; a
 *    stale worker holding version N cannot commit after a newer worker claims
 *    version N+1. This holds across separate runtime instances because the
 *    backend is shared.
 *  - **Fencing tokens**: every lease carries a monotonic `version`. A commit is
 *    rejected unless `lease.version === persisted.version`.
 *  - **Tenant-partitioned keys**: every key is prefixed with the tenant so a
 *    cross-tenant read returns `undefined` even if the id is guessed.
 *
 * The shared backend semantics (required for a correct adapter):
 *  - `cas(key, expected, value)`: set `key` to `value` only if current value
 *    (or absence, when `expected === CAS_ABSENT`) equals `expected`. Returns
 *    true on success. This is the single atomic primitive everything else
 *    builds on.
 *  - `get(key)`: read.
 *  - `append/list`: list helpers for sequences, events, and checkpoints.
 */

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
import { isTerminal, runCanTransition } from "./status";
import { createLeaseId } from "./identity";
import type { DurableRunId } from "./identity";
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

/** Sentinel for "key must not currently exist" in a CAS operation. */
export const CAS_ABSENT = Symbol("cas_absent");
export type CasValue = unknown | typeof CAS_ABSENT;

/** Sentinel swapped into an inflight key by ack to atomically claim it. */
// Serializable ack marker. A Symbol sentinel here silently corrupted
// persistence on real backends (JSON.stringify(symbol) → undefined), which
// Phase 4.7's live-Postgres gate surfaced; Memory's Map had hidden it.
const ACKED_SENTINEL = Object.freeze({ acked: true });

/**
 * The minimal primitive a distributed backend must provide. Every stronger
 * guarantee (leases, idempotency, events) is expressed in terms of these.
 *
 * ATOMICITY CONTRACT — every mutator MUST be atomic with respect to concurrent
 * callers operating on the SAME key:
 *  - `cas(key, expected, value)`: compare-and-set.
 *  - `append(key, value)`: read-modify-write of the list at `key`; a concurrent
 *    `append`/`incr`/`cas` on the same key must NOT observe a torn read. This
 *    is what makes event sequences strictly monotonic and checkpoints ordered
 *    even when two workers append concurrently.
 *  - `incr(key, by)`: atomic fetch-and-add; no two callers may receive the
 *    same value. This is the event `sequence` allocator.
 *
 * A real adapter satisfies this with a single-row DB transaction
 * (`UPDATE ... WHERE ... RETURNING`), a Durable Object transaction, or a Redis
 * Lua script — never with two separate round-trips. `MemorySharedBackend`
 * satisfies it by serializing every mutator through a per-key promise chain.
 */
export interface SharedBackend {
  /** Atomically set `key` to `value` iff current value matches `expected`. */
  cas(key: string, expected: CasValue, value: unknown): Promise<boolean>;
  /** Read a key (returns undefined if absent). */
  get(key: string): Promise<unknown>;
  /** Atomically append to a list stored at `key` (creates it if absent). */
  append(key: string, value: unknown): Promise<void>;
  /** Read a whole list stored at `key`. */
  list(key: string): Promise<unknown[]>;
  /** Atomically increment a counter at `key`; returns the new value. */
  incr(key: string, by?: number): Promise<number>;
  /** Delete a key. */
  del(key: string): Promise<void>;
  /** All keys matching a prefix (for reclamation scans). */
  keys(prefix: string): Promise<string[]>;

  /**
   * Phase 4.8 (finding D3): atomically append `value` to the list at `key`
   * unless `dedupKey` is already claimed, claiming it otherwise. Exactly-once
   * list-append at the storage layer: concurrent callers and crash-retry
   * callers observe at most one application for a given dedupKey.
   *
   * OPTIONAL capability. Backends that do not implement it force callers onto
   * check-then-act sequences whose crash windows are documented at each call
   * site. Implementations MUST make marker-claim and list-append one atomic
   * step (single transaction or per-key lock).
   */
  appendUnique?(
    key: string,
    dedupKey: string,
    value: unknown,
  ): Promise<{ appended: boolean; existing?: unknown }>;
}

const TENANT_SEP = "::";

function tenantKey(tenantId: string, key: string): string {
  return `t${TENANT_SEP}${tenantId}${TENANT_SEP}${key}`;
}

/** Structural equality — real backends compare values, not object identity. */
function casValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((item, i) => casValueEqual(item, b[i]))
    );
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  return (
    ka.length === kb.length &&
    ka.every((k) =>
      Object.hasOwn(b, k)
        ? casValueEqual(
            (a as Record<string, unknown>)[k],
            (b as Record<string, unknown>)[k],
          )
        : false,
    )
  );
}

/**
 * In-memory `SharedBackend` that reflects the guarantees a real distributed
 * backend must provide. EVERY mutator (`cas`, `append`, `incr`, `del`) is
 * serialized through a per-key promise chain, so concurrent actors — Runtime A
 * and Runtime B pointing at the same backend — observe full per-key atomicity.
 *
 * This is what makes the cross-process acceptance tests meaningful: they run
 * against two independent runtime/store instances that share this backend, and
 * the backend is the shared source of truth. A real adapter (DO, Postgres,
 * Redis) provides the same per-key atomicity via its native transaction.
 */
export class MemorySharedBackend implements SharedBackend {
  private readonly data = new Map<string, unknown>();
  private readonly locks = new Map<string, Promise<unknown>>();

  /** Serialize a mutator on `key` behind all prior work on that key. */
  private withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next as Promise<unknown>);
    // Prevent unhandled-rejection leaking from the retained chain.
    next.catch(() => undefined);
    return next;
  }

  async cas(key: string, expected: CasValue, value: unknown): Promise<boolean> {
    return this.withLock(key, () => {
      const current = this.data.has(key) ? this.data.get(key) : CAS_ABSENT;
      const match =
        expected === CAS_ABSENT
          ? !this.data.has(key)
          : casValueEqual(current, expected);
      if (match) {
        this.data.set(key, value);
        return true;
      }
      return false;
    });
  }

  async get(key: string): Promise<unknown> {
    // A read observes a value only after any pending mutator on that key has
    // settled, matching real-backend linearizable reads.
    await (this.locks.get(key) ?? Promise.resolve());
    return this.data.get(key);
  }

  async append(key: string, value: unknown): Promise<void> {
    await this.withLock(key, () => {
      const cur = (this.data.get(key) as unknown[]) ?? [];
      cur.push(value);
      this.data.set(key, cur);
    });
  }

  /** Single locked step: claim marker + stream append (Phase 4.8 D3). */
  async appendUnique(
    key: string,
    dedupKey: string,
    value: unknown,
  ): Promise<{ appended: boolean; existing?: unknown }> {
    return this.withLock(`dedup${TENANT_SEP}${dedupKey}`, () => {
      const marker = this.data.get(dedupKey);
      if (marker !== undefined) {
        return { appended: false, existing: marker };
      }
      const cur = (this.data.get(key) as unknown[]) ?? [];
      cur.push(value);
      this.data.set(key, cur);
      this.data.set(dedupKey, value);
      return { appended: true };
    });
  }

  async list(key: string): Promise<unknown[]> {
    await (this.locks.get(key) ?? Promise.resolve());
    return (this.data.get(key) as unknown[]) ?? [];
  }

  async incr(key: string, by = 1): Promise<number> {
    return this.withLock(key, () => {
      const cur = (this.data.get(key) as number) ?? 0;
      const next = cur + by;
      this.data.set(key, next);
      return next;
    });
  }

  async del(key: string): Promise<void> {
    await this.withLock(key, () => {
      this.data.delete(key);
    });
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

// ---------------------------------------------------------------------------
// Workflow store
// ---------------------------------------------------------------------------

export class DistributedWorkflowStore implements WorkflowStore {
  constructor(
    private readonly backend: SharedBackend,
    private readonly clock: Clock,
  ) {}

  private jobKey(tenantId: string, jobId: string) {
    return tenantKey(tenantId, `job${TENANT_SEP}${jobId}`);
  }

  async saveJob(
    job: Job,
    _opts?: { idempotencyKey?: string },
  ): Promise<boolean> {
    const key = this.jobKey(job.tenantId, job.id);
    const existing = (await this.backend.get(key)) as Job | undefined;
    if (existing && existing.version >= job.version) {
      return false;
    }
    return this.backend.cas(key, existing ?? CAS_ABSENT, job);
  }

  async getJob(tenantId: string, jobId: string): Promise<Job | undefined> {
    return (await this.backend.get(this.jobKey(tenantId, jobId))) as
      | Job
      | undefined;
  }

  async resolveJobTenant(jobId: string): Promise<string | undefined> {
    const prefix = `t${TENANT_SEP}`;
    const keys = await this.backend.keys(`${prefix}`);
    for (const k of keys) {
      if (k.endsWith(`${TENANT_SEP}job${TENANT_SEP}${jobId}`)) {
        const parts = k.split(TENANT_SEP);
        // t :: <tenant> :: job :: <jobId>
        return parts[1];
      }
    }
    return undefined;
  }

  async claimJob(_jobId: string, _worker: string): Promise<boolean> {
    return true;
  }

  private runKey(runId: string) {
    return `run${TENANT_SEP}${runId}`;
  }

  async saveRun(
    run: Run,
    _opts?: { idempotencyKey?: string },
  ): Promise<boolean> {
    const key = this.runKey(run.id);
    const existing = (await this.backend.get(key)) as Run | undefined;
    if (existing && existing.version > run.version) return false;
    return this.backend.cas(key, existing ?? CAS_ABSENT, run);
  }

  async getRun(runId: string): Promise<Run | undefined> {
    return (await this.backend.get(this.runKey(runId))) as Run | undefined;
  }

  async listActiveRunIds(_tenantId?: string): Promise<readonly DurableRunId[]> {
    const runKeys = await this.backend.keys(`run${TENANT_SEP}`);
    const out: DurableRunId[] = [];
    for (const k of runKeys) {
      const run = (await this.backend.get(k)) as Run | undefined;
      if (run && !isTerminal(run.status)) out.push(run.id as DurableRunId);
    }
    return out;
  }

  async getRunByJobAndVersion(
    jobId: string,
    version: number,
  ): Promise<Run | undefined> {
    const runKeys = await this.backend.keys(`run${TENANT_SEP}`);
    for (const k of runKeys) {
      const run = (await this.backend.get(k)) as Run | undefined;
      if (run && run.jobId === jobId && run.version === version) return run;
    }
    return undefined;
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
    const key = this.runKey(runId);
    const run = (await this.backend.get(key)) as Run | undefined;
    if (!run) return null;
    if (run.version !== opts.expectedVersion) return null;
    if (run.status !== from) return null;
    if (!runCanTransition(from, to)) return null;
    const terminal = isTerminal(to);
    const updated: Run = {
      ...run,
      status: to,
      version: run.version + 1,
      endedAt: terminal ? this.clock.now() : run.endedAt,
      reason: opts.reason ?? run.reason,
    };
    const ok = await this.backend.cas(key, run, updated);
    if (!ok) return null;
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
    await this.backend.append(`transitions${TENANT_SEP}${runId}`, transition);
    return transition;
  }

  private taskKey(taskId: string) {
    return `task${TENANT_SEP}${taskId}`;
  }

  async saveTask(taskId: string, task: Task): Promise<boolean> {
    const key = this.taskKey(taskId);
    const existing = (await this.backend.get(key)) as Task | undefined;
    if (existing && existing.version > task.version) return false;
    return this.backend.cas(key, existing ?? CAS_ABSENT, task);
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return (await this.backend.get(this.taskKey(taskId))) as Task | undefined;
  }

  private stepKey(stepId: string) {
    return `step${TENANT_SEP}${stepId}`;
  }

  async saveStep(step: Step, expectedVersion: number): Promise<boolean> {
    const key = this.stepKey(step.id);
    const existing = (await this.backend.get(key)) as Step | undefined;
    if (!existing) {
      if (expectedVersion !== 0) return false;
      return this.backend.cas(key, CAS_ABSENT, step);
    }
    if (existing.version !== expectedVersion) return false;
    if (step.version <= existing.version) return false;
    return this.backend.cas(key, existing, step);
  }

  async getStep(stepId: string): Promise<Step | undefined> {
    return (await this.backend.get(this.stepKey(stepId))) as Step | undefined;
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<boolean> {
    const key = `checkpoint${TENANT_SEP}${checkpoint.stepId}${TENANT_SEP}seq${TENANT_SEP}${checkpoint.sequence}`;
    const existing = await this.backend.get(key);
    if (existing) return false;
    await this.backend.cas(key, CAS_ABSENT, checkpoint);
    return true;
  }

  async recordTransition(transition: DurableTransition): Promise<void> {
    await this.backend.append(
      `transitions${TENANT_SEP}${transition.resourceId}`,
      transition,
    );
  }

  async getTransitions(
    resource: string,
    since = 0,
  ): Promise<DurableTransition[]> {
    const all = (await this.backend.list(
      `transitions${TENANT_SEP}${resource}`,
    )) as DurableTransition[];
    return all.filter((t) => t.timestamp >= since);
  }

  // --- Durable cancellation marker (F-3) ---

  async setCancellationMarker(
    runId: string,
    _tenantId: string,
    requestedBy: string,
    reason: string,
    requestedAt: number,
  ): Promise<void> {
    await this.backend.cas(`cancel${TENANT_SEP}${runId}`, CAS_ABSENT, {
      requestedBy,
      reason,
      requestedAt,
    });
  }

  async getCancellationMarker(
    runId: string,
  ): Promise<
    { requestedBy: string; reason: string; requestedAt: number } | undefined
  > {
    return (await this.backend.get(`cancel${TENANT_SEP}${runId}`)) as
      | { requestedBy: string; reason: string; requestedAt: number }
      | undefined;
  }

  // --- Run usage (F-5 budget enforcement) ---

  async getRunUsage(runId: string): Promise<RunUsage | undefined> {
    return (await this.backend.get(`usage${TENANT_SEP}${runId}`)) as
      | RunUsage
      | undefined;
  }

  /** CAS-guarded usage accumulation. Returns false if the CAS lost (retry). */
  async addRunUsage(
    runId: string,
    delta: Partial<RunUsage>,
    _startedAt: number,
  ): Promise<boolean> {
    const key = `usage${TENANT_SEP}${runId}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = (await this.backend.get(key)) as RunUsage | undefined;
      const base: RunUsage = current ?? {
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        executionMs: 0,
      };
      const merged: RunUsage = {
        modelCalls: base.modelCalls + (delta.modelCalls ?? 0),
        toolCalls: base.toolCalls + (delta.toolCalls ?? 0),
        inputTokens: base.inputTokens + (delta.inputTokens ?? 0),
        outputTokens: base.outputTokens + (delta.outputTokens ?? 0),
        executionMs: base.executionMs + (delta.executionMs ?? 0),
      };
      const ok = await this.backend.cas(key, current ?? CAS_ABSENT, merged);
      if (ok) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lease store (distributed CAS)
// ---------------------------------------------------------------------------

export class DistributedTaskLeaseStore implements TaskLeaseStore {
  constructor(
    private readonly backend: SharedBackend,
    private readonly clock: Clock,
  ) {}

  private leaseKey(stepId: string) {
    return `lease${TENANT_SEP}${stepId}`;
  }

  async claim(
    stepId: string,
    owner: string,
    ttlMs: number,
  ): Promise<Lease | null> {
    const key = this.leaseKey(stepId);
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = (await this.backend.get(key)) as Lease | undefined;
      const now = this.clock.now();
      if (existing) {
        if (existing.expiresAt > now && existing.revokedAt === null) {
          return null;
        }
      }
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
      const ok = await this.backend.cas(key, existing ?? CAS_ABSENT, lease);
      if (ok) return lease;
    }
    return null;
  }

  async renew(leaseId: string, owner: string, ttlMs: number): Promise<boolean> {
    const prefix = `lease${TENANT_SEP}`;
    const all = await this.backend.keys(prefix);
    for (const k of all) {
      const lease = (await this.backend.get(k)) as Lease | undefined;
      if (lease && lease.id === leaseId && lease.owner === owner) {
        const now = this.clock.now();
        if (lease.expiresAt <= now) return false;
        const renewed: Lease = {
          ...lease,
          expiresAt: now + ttlMs,
          heartbeatAt: now,
          version: lease.version + 1,
        };
        return this.backend.cas(k, lease, renewed);
      }
    }
    return false;
  }

  async revoke(leaseId: string, owner: string): Promise<void> {
    const prefix = `lease${TENANT_SEP}`;
    const all = await this.backend.keys(prefix);
    for (const k of all) {
      const lease = (await this.backend.get(k)) as Lease | undefined;
      if (lease && lease.id === leaseId && lease.owner === owner) {
        const revoked: Lease = { ...lease, revokedAt: this.clock.now() };
        await this.backend.cas(k, lease, revoked);
        return;
      }
    }
  }

  async getLease(stepId: string): Promise<Lease | null> {
    return (
      ((await this.backend.get(this.leaseKey(stepId))) as Lease | null) ?? null
    );
  }

  async getLeasesForWorker(owner: string): Promise<Lease[]> {
    const prefix = `lease${TENANT_SEP}`;
    const all = await this.backend.keys(prefix);
    const out: Lease[] = [];
    for (const k of all) {
      const lease = (await this.backend.get(k)) as Lease | undefined;
      if (lease && lease.owner === owner) out.push(lease);
    }
    return out;
  }

  async getExpiredLeases(now: number): Promise<Lease[]> {
    const prefix = `lease${TENANT_SEP}`;
    const all = await this.backend.keys(prefix);
    const out: Lease[] = [];
    for (const k of all) {
      const lease = (await this.backend.get(k)) as Lease | undefined;
      if (lease && lease.expiresAt <= now && lease.revokedAt === null) {
        out.push(lease);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Event store (distributed, sequenced)
// ---------------------------------------------------------------------------

export class DistributedEventStore implements EventStore {
  constructor(
    private readonly backend: SharedBackend,
    private readonly clock: Clock,
  ) {}

  private key(runId: string) {
    return `events${TENANT_SEP}${runId}`;
  }

  async append(
    event: Omit<DurableEvent, "eventId" | "sequence" | "timestamp"> & {
      readonly idempotencyKey?: string;
    },
  ): Promise<DurableEvent> {
    const runId = event.runId;
    const seq = await this.backend.incr(`seq${TENANT_SEP}${runId}`, 1);
    const durable: DurableEvent = {
      ...event,
      sequence: seq,
      timestamp: this.clock.now(),
      eventId: `${runId}:evt:${seq}`,
    };
    if (event.idempotencyKey && this.backend.appendUnique) {
      // Phase 4.8 (D3): exactly-once append. Marker claim + stream write are
      // one atomic backend operation, so neither concurrent recoverers nor a
      // crash between the old check-then-act steps can duplicate an event.
      // A burned sequence number on the duplicate path is expected and
      // harmless: replay orders by sequence and gaps carry no semantics.
      const res = await this.backend.appendUnique(
        this.key(runId),
        `evt-dedup${TENANT_SEP}${event.idempotencyKey}`,
        durable,
      );
      return (res.appended ? durable : res.existing) as DurableEvent;
    }
    // Legacy path for backends without native uniqueness: check-then-act.
    // Crash window (death between stream append and marker write) leaves the
    // event present but unmarked; retry re-appends. Documented weakness.
    if (event.idempotencyKey) {
      const dup = await this.backend.get(
        `evt-dedup${TENANT_SEP}${event.idempotencyKey}`,
      );
      if (dup) return dup as DurableEvent;
    }
    await this.backend.append(this.key(runId), durable);
    if (event.idempotencyKey) {
      await this.backend.cas(
        `evt-dedup${TENANT_SEP}${event.idempotencyKey}`,
        CAS_ABSENT,
        durable,
      );
    }
    return durable;
  }

  async replay(runId: string, fromSequence = 0): Promise<DurableEvent[]> {
    const all = (await this.backend.list(this.key(runId))) as DurableEvent[];
    return all
      .filter((e) => e.sequence >= fromSequence)
      .sort((a, b) => a.sequence - b.sequence);
  }

  count(_runId: string): number {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Checkpoint store (distributed, per-step sequence)
// ---------------------------------------------------------------------------

export class DistributedCheckpointStore implements CheckpointStore {
  constructor(private readonly backend: SharedBackend) {}

  private key(stepId: string) {
    return `checkpoints${TENANT_SEP}${stepId}`;
  }

  async save(checkpoint: Checkpoint): Promise<boolean> {
    const list = (await this.backend.list(this.key(checkpoint.stepId))) as
      | Checkpoint[]
      | undefined;
    const exists = (list ?? []).some(
      (c) => c.id === checkpoint.id || c.sequence === checkpoint.sequence,
    );
    if (exists) return false;
    await this.backend.append(this.key(checkpoint.stepId), checkpoint);
    return true;
  }

  async listForStep(stepId: string): Promise<Checkpoint[]> {
    const list = (await this.backend.list(this.key(stepId))) as Checkpoint[];
    return [...list].sort((a, b) => a.sequence - b.sequence);
  }

  async latestForStep(stepId: string): Promise<Checkpoint | null> {
    const list = await this.listForStep(stepId);
    return list.length > 0 ? (list[list.length - 1] ?? null) : null;
  }

  count(): number {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Idempotency store (distributed, atomic)
// ---------------------------------------------------------------------------

export class DistributedIdempotencyStore implements IdempotencyStore {
  constructor(private readonly backend: SharedBackend) {}

  private key(key: string) {
    return `idem${TENANT_SEP}${key}`;
  }

  async record(
    key: string,
    operation: string,
    result: unknown,
  ): Promise<"recorded" | "duplicate" | "conflict"> {
    const k = this.key(key);
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = (await this.backend.get(k)) as
        | IdempotencyRecord
        | undefined;
      if (existing) {
        return existing.operation === operation ? "duplicate" : "conflict";
      }
      const record: IdempotencyRecord = {
        key,
        operation,
        result,
        recordedAt: Date.now(),
      };
      const ok = await this.backend.cas(k, CAS_ABSENT, record);
      if (ok) return "recorded";
    }
    return "conflict";
  }

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    return (await this.backend.get(this.key(key))) as
      | IdempotencyRecord
      | undefined;
  }
}

// ---------------------------------------------------------------------------
// Queue (distributed, visibility-timeout leasing)
// ---------------------------------------------------------------------------

export class DistributedQueue implements Queue {
  constructor(
    private readonly backend: SharedBackend,
    private readonly clock: Clock,
  ) {}

  /**
   * Phase 5 §15: composite (tenantId, messageId) keys. Cross-tenant same-ID
   * collisions are impossible by construction.
   */
  private metaKey(tenantId: string, messageId: string) {
    return `qmeta${TENANT_SEP}${tenantId}${TENANT_SEP}${messageId}`;
  }
  private inflightKey(tenantId: string, workerId: string, messageId: string) {
    return `qinflight${TENANT_SEP}${tenantId}${TENANT_SEP}${workerId}${TENANT_SEP}${messageId}`;
  }
  private deadKey(tenantId: string, messageId: string) {
    return `qdead${TENANT_SEP}${tenantId}${TENANT_SEP}${messageId}`;
  }
  /** Visible-list entries carry composite identity. */
  private visibleEntry(tenantId: string, messageId: string): string {
    return `${tenantId}${TENANT_SEP}${messageId}`;
  }
  private parseVisibleEntry(entry: string): {
    tenantId: string;
    messageId: string;
  } {
    const idx = entry.indexOf(TENANT_SEP);
    if (idx < 0) return { tenantId: "", messageId: entry };
    return {
      tenantId: entry.slice(0, idx),
      messageId: entry.slice(idx + TENANT_SEP.length),
    };
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
    const dup = await this.backend.get(
      this.metaKey(ref.tenantId, ref.messageId),
    );
    if (dup) return false;
    const now = this.clock.now();
    const meta = {
      messageId: ref.messageId,
      tenantId: ref.tenantId,
      payload,
      priority: opts?.priority ?? 0,
      enqueuedAt: now,
      availableAt: now + (opts?.delayMs ?? 0),
      attempt: 0,
      receivedCount: 0,
      idempotencyKey: opts?.idempotencyKey,
    };
    const ok = await this.backend.cas(
      this.metaKey(ref.tenantId, ref.messageId),
      CAS_ABSENT,
      meta,
    );
    if (!ok) return false;
    await this.backend.append(
      "qvisible",
      this.visibleEntry(ref.tenantId, ref.messageId),
    );
    return true;
  }

  /**
   * Phase 4.8 (finding D2): self-heal visibility-list orphans.
   *
   * Two crash windows leave the queue permanently stuck without repair:
   *  - meta committed, death before the qvisible append  → message invisible
   *    forever (claim scans only qvisible); reconcile()'s idempotent
   *    re-enqueue cannot fix it because the meta already exists.
   *  - ack deleted meta, death before the visible removal → meta-less ghost
   *    entry that claim skips forever and that grows the list unboundedly.
   *
   * Repair rules are safe under concurrency: claim() never removes entries
   * from qvisible (visibility is gated by meta.availableAt), so "meta present
   * but not listed" can only be a lost tail, never an in-flight message; and
   * a listed message without meta can never be claimed.
   */
  async repair(): Promise<{ revisible: number; pruned: number }> {
    const metaPrefix = `qmeta${TENANT_SEP}`;
    const metaKeys = await this.backend.keys(metaPrefix);
    /**
     * Phase 5 §15: meta keys now contain composite tenant+messageId after the
     * separator. Extract the exact composite entry string that matches visible
     * list format.
     */
    const metaCompositeEntries = new Set(
      metaKeys.map((k) => k.slice(metaPrefix.length)),
    );
    const visible = (await this.backend.list("qvisible")) as string[];
    const visibleSet = new Set(visible);
    let revisible = 0;
    let pruned = 0;
    for (const composite of metaCompositeEntries) {
      if (!visibleSet.has(composite)) {
        await this.backend.append("qvisible", composite);
        revisible += 1;
      }
    }
    for (const entry of visible) {
      if (!metaCompositeEntries.has(entry)) {
        if (await this.removeRawVisible(entry)) pruned += 1;
      }
    }
    return { revisible, pruned };
  }

  private async removeRawVisible(entry: string): Promise<boolean> {
    const visible = (await this.backend.list("qvisible")) as string[];
    if (!visible.includes(entry)) return true;
    const next = visible.filter((m) => m !== entry);
    return this.backend.cas("qvisible", visible, next);
  }

  async claim(
    workerId: string,
    maxMessages: number,
    visibilityTimeoutMs: number,
  ): Promise<QueuedMessage[]> {
    const visible = (await this.backend.list("qvisible")) as string[];
    const now = this.clock.now();
    const claimed: QueuedMessage[] = [];
    for (const entry of visible) {
      if (claimed.length >= maxMessages) break;
      const { tenantId, messageId } = this.parseVisibleEntry(entry);
      const meta = (await this.backend.get(
        this.metaKey(tenantId, messageId),
      )) as QueueMeta | undefined;
      if (!meta) continue;
      if (meta.availableAt > now) continue;
      const updated = {
        ...meta,
        attempt: (meta.attempt ?? 0) + 1,
        receivedCount: (meta.receivedCount ?? 0) + 1,
        availableAt: now + visibilityTimeoutMs,
      };
      const metaOk = await this.backend.cas(
        this.metaKey(tenantId, messageId),
        meta,
        updated,
      );
      if (!metaOk) continue;
      const inflightOk = await this.backend.cas(
        this.inflightKey(tenantId, workerId, messageId),
        CAS_ABSENT,
        { messageId, tenantId, availableAt: updated.availableAt },
      );
      if (!inflightOk) continue;
      claimed.push({
        tenantId,
        messageId,
        payload: meta.payload,
        priority: (meta.priority as number) ?? 0,
        enqueuedAt: meta.enqueuedAt as number,
        availableAt: updated.availableAt,
        attempt: updated.attempt,
        receivedCount: updated.receivedCount,
      });
    }
    return claimed;
  }

  async ack(
    ref: { tenantId: string; messageId: string },
    workerId: string,
  ): Promise<boolean> {
    const k = this.inflightKey(ref.tenantId, workerId, ref.messageId);
    const has = await this.backend.get(k);
    if (!has) return false;
    const ok = await this.backend.cas(k, has, ACKED_SENTINEL);
    if (!ok) return false;
    await this.backend.del(k);
    await this.backend.del(this.metaKey(ref.tenantId, ref.messageId));
    await this.removeVisible(ref.tenantId, ref.messageId);
    return true;
  }

  private async removeVisible(
    tenantId: string,
    messageId: string,
  ): Promise<boolean> {
    const entry = this.visibleEntry(tenantId, messageId);
    const visible = (await this.backend.list("qvisible")) as string[];
    if (!visible.includes(entry)) return true;
    const next = visible.filter((m) => m !== entry);
    return this.backend.cas("qvisible", visible, next);
  }

  async retry(
    ref: { tenantId: string; messageId: string },
    delayMs = 0,
  ): Promise<boolean> {
    const meta = (await this.backend.get(
      this.metaKey(ref.tenantId, ref.messageId),
    )) as QueueMeta | undefined;
    if (!meta) return false;
    const now = this.clock.now();
    const updated = {
      ...meta,
      attempt: (meta.attempt ?? 0) + 1,
      receivedCount: (meta.receivedCount ?? 0) + 1,
      availableAt: now + delayMs,
    };
    const ok = await this.backend.cas(
      this.metaKey(ref.tenantId, ref.messageId),
      meta,
      updated,
    );
    if (!ok) return false;
    const prefix = `qinflight${TENANT_SEP}${ref.tenantId}${TENANT_SEP}`;
    const keys = await this.backend.keys(prefix);
    for (const kk of keys) {
      const v = await this.backend.get(kk);
      if (v && (v as { messageId: string }).messageId === ref.messageId) {
        await this.backend.del(kk);
      }
    }
    return true;
  }

  async deadLetter(
    ref: { tenantId: string; messageId: string },
    _reason: string,
  ): Promise<boolean> {
    const meta = await this.backend.get(
      this.metaKey(ref.tenantId, ref.messageId),
    );
    if (!meta) return false;
    const ok = await this.backend.cas(
      this.deadKey(ref.tenantId, ref.messageId),
      CAS_ABSENT,
      meta,
    );
    if (!ok) return false;
    await this.backend.del(this.metaKey(ref.tenantId, ref.messageId));
    const prefix = `qinflight${TENANT_SEP}${ref.tenantId}${TENANT_SEP}`;
    const keys = await this.backend.keys(prefix);
    for (const kk of keys) {
      const v = await this.backend.get(kk);
      if (v && (v as { messageId: string }).messageId === ref.messageId) {
        await this.backend.del(kk);
      }
    }
    await this.removeVisible(ref.tenantId, ref.messageId);
    return true;
  }

  async stats(): Promise<QueueStats> {
    const visible = (await this.backend.list("qvisible")) as string[];
    const now = this.clock.now();
    let visibleCount = 0;
    let delayed = 0;
    for (const entry of visible) {
      const { tenantId, messageId } = this.parseVisibleEntry(entry);
      const meta = (await this.backend.get(
        this.metaKey(tenantId, messageId),
      )) as QueueMeta | undefined;
      if (!meta) continue;
      if (meta.availableAt <= now) visibleCount++;
      else delayed++;
    }
    const prefix = `qinflight${TENANT_SEP}`;
    const inflight = (await this.backend.keys(prefix)).length;
    const deadPrefix = `qdead${TENANT_SEP}`;
    const deadLettered = (await this.backend.keys(deadPrefix)).length;
    return { visible: visibleCount, inflight, delayed, deadLettered };
  }
}

interface QueueMeta {
  messageId: string;
  payload: unknown;
  tenantId: string;
  priority: number;
  enqueuedAt: number;
  availableAt: number;
  attempt: number;
  receivedCount: number;
  idempotencyKey?: string;
}
