/**
 * Vaulltcore Durable Execution — lease lifecycle & fencing helpers.
 *
 * A lease is the durable-fencing primitive that prevents a "zombie" worker
 * (one whose process died mid-step) from committing a stale result after a
 * newer worker has claimed the same step.
 *
 * The lifecycle:
 *   claim → (heartbeat)* → revoke
 *
 * Fencing: a worker may only commit a step result if the `lease.version` it
 * holds matches the version persisted at commit time. A worker that loses
 * leadership (its lease expired or was revoked) has a stale version and its
 * commit is rejected.
 *
 * This module wraps the `TaskLeaseStore` contract with higher-level helpers:
 *  - `leaseDuration`: compute the lease TTL based on the step deadline.
 *  - `isLeaseValid`: check not expired + not revoked.
 *  - `shouldRenew`: decide whether a heartbeat is due.
 *  - `verifyFencing`: the CAS guard that gates commit.
 */

import type { Lease } from "./model";

/** Lightweight view of a `Lease` suitable for passing to a worker. */
export interface StepLease {
  readonly stepId: string;
  readonly leaseId: string;
  readonly owner: string;
  readonly version: number;
  readonly expiresAt: number;
  readonly grantedAt: number;
  readonly revokedAt: number | null;
}

/**
 * Step-level lease duration configuration.
 * The lease TTL is the lesser of:
 *  - a fixed grace window (default 30s), and
 *  - the remaining step deadline (so a step cannot outlive its time budget).
 */
export const DEFAULT_LEASE_TTL_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;

export interface LeaseConfig {
  readonly ttlMs: number;
  readonly heartbeatIntervalMs: number;
}

export const DEFAULT_LEASE_CONFIG: LeaseConfig = {
  ttlMs: DEFAULT_LEASE_TTL_MS,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
};

/**
 * Compute the lease TTL given a remaining step deadline.
 */
export function computeLeaseTtl(
  deadlineAt: number | undefined,
  now: number,
  config: LeaseConfig,
): number {
  if (deadlineAt === undefined) {
    return config.ttlMs;
  }
  const remaining = deadlineAt - now;
  if (remaining <= 0) {
    return 1;
  }
  return Math.min(remaining, config.ttlMs);
}

/**
 * Returns true if the lease is currently valid for the holder:
 * not expired and not revoked.
 */
export function isLeaseValid(lease: Lease, now: number): boolean {
  return lease.expiresAt > now && lease.revokedAt === null;
}

/**
 * Returns true when a heartbeat is due — the lease will expire within one
 * heartbeat interval, so the owner must renew now.
 */
export function shouldRenew(
  lease: Lease,
  now: number,
  config: LeaseConfig,
): boolean {
  const timeUntilExpiry = lease.expiresAt - now;
  return timeUntilExpiry <= config.heartbeatIntervalMs;
}

/**
 * Fencing guard: verify that the lease the worker believes it holds is still
 * the authoritative one. Returns `true` only if every check passes:
 *
 *  - the lease exists,
 *  - it is owned by `owner`,
 *  - its `leaseId` matches the one the worker was granted,
 *  - its `version` matches (not been superseded by a newer claim),
 *  - it has not expired.
 */
export function verifyFencing(
  lease: Lease | null | undefined,
  owner: string,
  leaseId: string,
  version: number,
  now: number,
): boolean {
  if (!lease) return false;
  if (lease.owner !== owner) return false;
  if (lease.id !== leaseId) return false;
  if (lease.version !== version) return false;
  if (lease.expiresAt <= now) return false;
  if (lease.revokedAt !== null) return false;
  return true;
}

/**
 * Convert a model `Lease` to the contracts' `StepLease` view (a lightweight,
 * version-fenced snapshot). This is used when the runtime needs to pass a
 * lease to a worker alongside the step payload.
 */
export function toStepLease(lease: Lease): StepLease {
  return {
    stepId: lease.stepId,
    leaseId: lease.id,
    owner: lease.owner,
    version: lease.version,
    expiresAt: lease.expiresAt,
    grantedAt: lease.heartbeatAt,
    revokedAt: lease.revokedAt,
  };
}

/**
 * Build a `StepLease` from a `Lease` and a heartbeat timestamp, suitable for
 * re-persisting after a heartbeat.
 */
export function refreshedLease(
  lease: Lease,
  ttlMs: number,
  now: number,
): Lease {
  return {
    ...lease,
    expiresAt: now + ttlMs,
    heartbeatAt: now,
    version: lease.version + 1,
  };
}
