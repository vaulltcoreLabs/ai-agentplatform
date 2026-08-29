/**
 * Phase 4.6 — database error classification + bounded retry.
 *
 * Reuses the workflow philosophy (bounded retry with backoff; never retry
 * permanent errors). Classes:
 *
 *  TRANSIENT (safe to retry — the operation did not durably commit or the
 *  conflict is resolvable by re-running):
 *    - SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT   (writer contention, SQLite)
 *    - PG 40001 serialization_failure
 *    - PG 40P01 deadlock_detected
 *    - connection refused/reset/terminated, timeout
 *
 *  PERMANENT (never retried):
 *    - constraint violations (23505 unique etc.) — the CALLER decides what a
 *      duplicate means (idempotency treats it as "already done")
 *    - syntax/schema errors, permission denied
 *    - anything unrecognized defaults to permanent: retrying unknown failures
 *      risks duplicating side effects.
 */

export type DatabaseErrorClass = "transient" | "permanent";

const TRANSIENT_SQLITE = new Set([
  "SQLITE_BUSY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_IOERR_BLOCKED",
]);

const TRANSIENT_PG_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
]);

export function classifyDatabaseError(error: unknown): DatabaseErrorClass {
  if (error && typeof error === "object") {
    const err = error as { code?: unknown; message?: unknown };
    const code = typeof err.code === "string" ? err.code : undefined;
    const message = typeof err.message === "string" ? err.message : "";

    if (code && TRANSIENT_SQLITE.has(code)) return "transient";
    if (code && TRANSIENT_PG_CODES.has(code)) return "transient";
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      code === "ETIMEDOUT"
    ) {
      return "transient";
    }
    if (
      /connection terminated|connection closed|too many connections/i.test(
        message,
      )
    ) {
      return "transient";
    }
  }
  return "permanent";
}

export interface RetryOptions {
  /** Max attempts INCLUDING the first (default 4). */
  retries?: number;
  /** Base backoff in ms (default 25) — doubled per attempt with ±50% jitter. */
  baseDelayMs?: number;
}

/**
 * Bounded retry for transient failures only. Permanent errors propagate on
 * the first attempt. Jitter prevents synchronized retry storms across workers.
 */
export async function withDatabaseRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 25;

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries || classifyDatabaseError(error) === "permanent") {
        throw error;
      }
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const jittered = backoff * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, jittered));
    }
  }
  throw lastError;
}
