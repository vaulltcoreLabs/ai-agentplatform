/**
 * Vaulltcore Durable Execution — security utilities.
 *
 * Provides input validation, authorization, and secret redaction for the
 * durable layer. Reuses the Phase 3 `redactSecrets` helper from
 * `@vaulltcore/intelligence` (which itself delegates to `@vaulltcore/agent`)
 * so the redaction rules are centralized.
 *
 * The durable layer adds:
 *  - `validateObjective`: a conservative length + character check so a
 *    malformed objective cannot produce a degenerate deterministic id or be
 *    used to probe the content-addressable namespace.
 *  - `authorize`: a simple tenant-ownership gate used by every store operation.
 *  - `redactDurableEvent`: redacts the `payload` of a durable event before it
 *    is returned to an untrusted caller.
 */

import { redactSecrets } from "@vaulltcore/intelligence";
import type { DurableEvent, FailureRecord } from "./model";
import type { TenantId } from "./identity";

const MAX_OBJECTIVE_LENGTH = 4096;
const MIN_OBJECTIVE_LENGTH = 1;

/**
 * Validate a user-supplied engineering objective string.
 * Returns `undefined` if valid, or a human-readable reason if invalid.
 */
export function validateObjective(objective: string): string | undefined {
  if (typeof objective !== "string") {
    return "objective must be a string";
  }
  if (objective.trim().length < MIN_OBJECTIVE_LENGTH) {
    return "objective must not be empty";
  }
  if (objective.length > MAX_OBJECTIVE_LENGTH) {
    return `objective exceeds max length (${MAX_OBJECTIVE_LENGTH})`;
  }
  if (objective.includes("\0")) {
    return "objective must not contain null bytes";
  }
  return undefined;
}

/**
 * Redact credential material (GitHub tokens, API keys, bearer tokens, …)
 * from an objective BEFORE it feeds any durable record or deterministic id.
 *
 * Redaction is a pure, deterministic string transform: the same raw input
 * always yields the same output, so idempotency keys and content-addressed
 * job ids derived from a redacted objective remain stable across retries.
 * This closes the Phase 5.1 finding where a user-supplied objective could
 * persist live credential material into the durable store unredacted.
 */
export function redactObjective(objective: string): string {
  return redactSecrets(objective);
}

/**
 * Authorize a cross-tenant access attempt. Returns `true` when the
 * `callerTenantId` may access a resource owned by `resourceTenantId`.
 * Tenants always own their own resources; cross-tenant access is never
 * permitted in the durable layer (multi-tenant isolation boundary).
 */
export function authorize(
  callerTenantId: TenantId,
  resourceTenantId: TenantId,
): boolean {
  return callerTenantId === resourceTenantId;
}

/**
 * Redact secrets from a failure record before surfacing it. Secrets may
 * appear in `message` (file paths, URLs, env-var values). We clone then
 * redact the message field.
 */
export function redactFailure(failure: FailureRecord): FailureRecord {
  return {
    ...failure,
    message: redactSecrets(failure.message),
  };
}

/**
 * Redact secrets from a durable event's payload before returning to a caller.
 * The payload is an arbitrary `Record<string, unknown>`; we deep-clone and
 * recursively redact string values.
 */
export function redactDurableEvent(event: DurableEvent): DurableEvent {
  return {
    ...event,
    payload: deepRedact(event.payload) as Record<string, unknown>,
  };
}

function deepRedact(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(deepRedact);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = deepRedact(v);
    }
    return result;
  }
  return value;
}
