/**
 * Vaulltcore Durable Execution — identity & idempotency keys.
 *
 * Phase 4 establishes deterministic, tenant-scoped identifiers and idempotency
 * keys for the durable Job / Run / Task / Step hierarchy. These are distinct
 * from — but mappable to — the Phase 3 deterministic ids (`createJobId`,
 * `createTaskId`): Phase 3 ids are content-addressable engineering identities,
 * whereas Phase 4 durable ids additionally carry a run-version and attempt.
 *
 * Idempotency keys are the durability primitive: any externally triggered
 * operation may be retried or redelivered. A key is derived from
 * (tenantId, resourceId, operation) and stored in an `IdempotencyStore` so a
 * duplicate submission returns the prior result instead of a second effect.
 */

import { createHash } from "node:crypto";

export type DurableJobId = string;
export type DurableRunId = string;
export type DurableTaskId = string;
export type DurableStepId = string;
export type TenantId = string;
export type WorkerId = string;
export type IdempotencyKey = string;

/** Prefix namespace for durable identifiers. */
export interface DurableIdNamespace {
  readonly prefix: string;
  /** Tenant-scoped salt so identical inputs differ across tenants. */
  readonly salt: string;
}

/**
 * Derive a stable, opaque durable identifier from a namespace and deterministic
 * parts. The same inputs + salt always yield the same id (idempotency).
 */
export function durableId(
  namespace: DurableIdNamespace,
  ...parts: string[]
): string {
  const hash = createHash("sha256")
    .update([namespace.salt, ...parts].map((p) => p ?? "").join("\n"))
    .digest("hex");
  return `${namespace.prefix}_${hash.slice(0, 16)}`;
}

/** Deterministic job namespace, keyed on tenant. */
export function jobNamespace(tenantId: TenantId): DurableIdNamespace {
  return { prefix: "djob", salt: tenantId };
}

/** Deterministic run namespace, keyed on job id + version. */
export function runNamespace(jobId: DurableJobId): DurableIdNamespace {
  return { prefix: "drun", salt: jobId };
}

/** Deterministic task namespace, keyed on job id. */
export function taskNamespace(jobId: DurableJobId): DurableIdNamespace {
  return { prefix: "dtask", salt: jobId };
}

/** Deterministic step namespace, keyed on task id + attempt. */
export function stepNamespace(taskId: DurableTaskId): DurableIdNamespace {
  return { prefix: "dstep", salt: taskId };
}

/**
 * Deterministic job id, mirroring Phase 3's `createJobId` semantics but
 * tagged with the `djob` prefix so the durable layer's primary key space is
 * disjoint from Phase 3's `job_` space. Same (tenant, objective) → same job.
 */
export function createDurableJobId(
  tenantId: TenantId,
  objective: string,
): DurableJobId {
  return durableId(jobNamespace(tenantId), objective.trim());
}

/**
 * Deterministic run id. A new run is created per execution attempt; the same
 * logical attempt always maps to the same id so re-submission is safe.
 */
export function createDurableRunId(
  jobId: DurableJobId,
  version: number,
): DurableRunId {
  return durableId(runNamespace(jobId), version.toString());
}

/**
 * Deterministic task id within a job. Mirrors Phase 3's content-addressable
 * task dedup: identical specialist + input → same task.
 */
export function createDurableTaskId(
  jobId: DurableJobId,
  descriptor: string,
): DurableTaskId {
  return durableId(taskNamespace(jobId), descriptor);
}

/**
 * Deterministic step id within a task for a given attempt. Each retryable
 * attempt of a task gets a distinct, content-addressable step id so checkpoints
 * are never confused across attempts.
 */
export function createDurableStepId(
  taskId: DurableTaskId,
  attempt: number,
): DurableStepId {
  return durableId(stepNamespace(taskId), attempt.toString());
}

/**
 * Build an idempotency key for an externally-triggered durable operation.
 *
 * The key is derived from the tenant, the resource id, and an operation
 * discriminator. Two identical submissions therefore hash to the same key.
 */
export function idemKey(
  tenantId: TenantId,
  resourceId: string,
  operation: string,
): IdempotencyKey {
  const hash = createHash("sha256")
    .update(`${tenantId}\n${resourceId}\n${operation}`)
    .digest("hex");
  return `idem_${hash.slice(0, 24)}`;
}

/** Random opaque worker id, tenant-scoped for observability. */
export function createWorkerId(tenantId: TenantId): WorkerId {
  const rand = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `${tenantId.substring(0, 8)}:worker:${rand.substring(0, 12)}`;
}

/** Random opaque lease id. */
export function createLeaseId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `lease_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
