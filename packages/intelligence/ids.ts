/**
 * Vaulltcore Intelligence — deterministic identifier generation.
 *
 * Phase 3 requires deterministic, idempotent identifiers so that re-running a
 * job for the same objective + tenant resumes the same job rather than
 * spawning a new one. Identifiers are derived from a stable input plus a
 * tenant-scoped salt; they are opaque to clients (no embedded meaning).
 *
 * Transient runtime correlation (agent run, tool call, sandbox handle) uses
 * random UUIDs and is handled in `correlation.ts`.
 */

import { createHash } from "node:crypto";

export type VcoreId = string;

export interface IdNamespace {
  /** Short prefix, e.g. "job", "task", "attempt". */
  readonly prefix: string;
  /** Tenant-scoped salt so identical inputs differ across tenants. */
  readonly salt: string;
}

/**
 * Derive a stable, opaque identifier from a namespace and deterministic inputs.
 * The same inputs + salt always yield the same id (idempotency).
 */
export function deterministicId(
  namespace: IdNamespace,
  ...parts: string[]
): VcoreId {
  const hash = createHash("sha256")
    .update(parts.map((p) => p ?? "").join("\n"))
    .digest("hex");
  return `${namespace.prefix}_${hash.slice(0, 16)}`;
}

export function jobIdNamespace(tenantId: string): IdNamespace {
  return { prefix: "job", salt: tenantId };
}

export function taskIdNamespace(jobId: string): IdNamespace {
  return { prefix: "task", salt: jobId };
}

/** Deterministic job id: same (tenant, objective) → same job. */
export function createJobId(tenantId: string, objective: string): VcoreId {
  return deterministicId(jobIdNamespace(tenantId), objective.trim());
}

/**
 * Deterministic task id within a job. The `descriptor` is a stable, content-
 * addressable signature of the task (name + input hash), so identical tasks
 * dedupe to the same id.
 */
export function createTaskId(jobId: string, descriptor: string): VcoreId {
  return deterministicId(taskIdNamespace(jobId), descriptor);
}

/**
 * Stable signature for a task's input. Two tasks with the same specialist and
 * input signature resolve to the same task id, enabling duplicate-work
 * prevention in the scheduler.
 */
export function taskInputSignature(specialist: string, input: unknown): string {
  return `${specialist}:${canonicalize(input)}`;
}

function canonicalize(input: unknown): string {
  if (input === null || input === undefined) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (typeof input === "object") {
    try {
      return JSON.stringify(sortKeys(input as Record<string, unknown>));
    } catch {
      return String(input);
    }
  }
  return String(input);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortKeys(record[key]);
    }
    return out;
  }
  return value;
}
