/**
 * Vaulltcore Intelligence — memory contract (architectural boundary).
 *
 * Phase 3 defines the *contract* for durable, categorized memory. Storage
 * implementations (vector DB, KV, Postgres, in-process) are intentionally
 * deferred to later phases. The intelligence layer only depends on these
 * interfaces.
 *
 * Memory tiers are strictly separated so working state is never confused with
 * project knowledge or telemetry:
 *
 *  Working Context     — ephemeral, task-scoped scratch (not durable).
 *  Job State           — durable, job-specific facts (plan, attempts, results).
 *  Project Knowledge   — durable facts about a repository / project.
 *  Long-Term Knowledge — durable cross-job learnings (strategies, failures).
 *  Telemetry           — durable execution metrics (never mixed with state).
 */

export type MemoryScope =
  | "working"
  | "job"
  | "project"
  | "long-term"
  | "telemetry";

export interface MemoryRecord {
  readonly scope: MemoryScope;
  readonly key: string;
  readonly value: unknown;
  readonly tenantId: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly ttlMs?: number;
}

export interface JobFact {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: number;
}

export interface ProjectFact {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: number;
  readonly confidence: number;
}

export interface StrategyRecord {
  readonly key: string;
  readonly objective: string;
  readonly succeeded: boolean;
  /** Opaque summary of the strategy that worked / failed. */
  readonly summary: string;
  readonly usage?: Record<string, number>;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly hits: number;
}

export interface MemoryQuery {
  readonly scope: MemoryScope;
  /** Prefix or exact key match. */
  readonly key?: string;
  readonly tenantId: string;
  readonly limit?: number;
}

export interface MemoryContract {
  /** Write a structured record. No-op in the default in-memory store. */
  write(record: Omit<MemoryRecord, "createdAt">): Promise<void>;
  /** Query records by scope + tenant + optional key prefix. */
  query(query: MemoryQuery): Promise<MemoryRecord[]>;
  /** Read a job-scoped fact. */
  getJobFact(tenantId: string, key: string): Promise<JobFact | undefined>;
  /** Read a project-scoped fact. */
  getProjectFact(
    tenantId: string,
    project: string,
    key: string,
  ): Promise<ProjectFact | undefined>;
  /** Append a learned strategy (success or failure pattern). */
  rememberStrategy(
    tenantId: string,
    strategy: Omit<StrategyRecord, "firstSeen" | "lastSeen" | "hits">,
  ): Promise<void>;
  /** Recall strategies for an objective, ranked by confidence / recency. */
  recallStrategies(
    tenantId: string,
    objective: string,
    limit?: number,
  ): Promise<StrategyRecord[]>;
  /** Increment a budget/usage counter atomically. */
  incrementCounter(tenantId: string, key: string, by?: number): Promise<number>;
  /** Forget records matching a query (data-governance / right-to-erase). */
  forget(query: MemoryQuery): Promise<number>;
}

/**
 * Default no-op memory implementation. Purely in-memory per process; satisfies
 * the contract so the intelligence layer is usable without a storage backend.
 * Real deployments inject a persistent adapter.
 */
export class NoopMemory implements MemoryContract {
  async write(): Promise<void> {}
  async query(): Promise<MemoryRecord[]> {
    return [];
  }
  async getJobFact(): Promise<JobFact | undefined> {
    return undefined;
  }
  async getProjectFact(): Promise<ProjectFact | undefined> {
    return undefined;
  }
  async rememberStrategy(): Promise<void> {}
  async recallStrategies(): Promise<StrategyRecord[]> {
    return [];
  }
  async incrementCounter(): Promise<number> {
    return 0;
  }
  async forget(): Promise<number> {
    return 0;
  }
}

export const noopMemory: MemoryContract = new NoopMemory();
