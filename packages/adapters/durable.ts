/**
 * Phase 4.5 — composition root for the SQLite-backed durable stack.
 *
 * Wires the provider-neutral `Distributed*` stores from `@vaulltcore/workflow`
 * onto one `SqliteSharedBackend`. Multiple processes may each call
 * `openDurableSqlite(path)` on the same file: they coordinate purely through
 * durable state, exactly as Runtime A / Runtime B do in production.
 */

import {
  DistributedCheckpointStore,
  DistributedEventStore,
  DistributedIdempotencyStore,
  DistributedQueue,
  DistributedTaskLeaseStore,
  DistributedWorkflowStore,
  SystemClock,
} from "@vaulltcore/workflow";
import { SqliteSharedBackend } from "./sqlite-backend";

export interface DurableSqliteHandles {
  readonly backend: SqliteSharedBackend;
  readonly workflow: DistributedWorkflowStore;
  readonly leases: DistributedTaskLeaseStore;
  readonly events: DistributedEventStore;
  readonly checkpoints: DistributedCheckpointStore;
  readonly idempotency: DistributedIdempotencyStore;
  readonly queue: DistributedQueue;
  /** Close the underlying connection (only if this handle opened it). */
  close(): void;
}

/**
 * Open the full durable store set over one SQLite database file.
 *
 * Each call opens its OWN connection — two handles on the same path are two
 * independent runtimes sharing durable state, not shared in-process memory.
 */
export function openDurableSqlite(path: string): DurableSqliteHandles {
  const backend = new SqliteSharedBackend(path);
  const clock = new SystemClock();
  return {
    backend,
    workflow: new DistributedWorkflowStore(backend, clock),
    leases: new DistributedTaskLeaseStore(backend, clock),
    events: new DistributedEventStore(backend, clock),
    checkpoints: new DistributedCheckpointStore(backend),
    idempotency: new DistributedIdempotencyStore(backend),
    queue: new DistributedQueue(backend, clock),
    close: () => backend.close(),
  };
}

export { SqliteSharedBackend } from "./sqlite-backend";
