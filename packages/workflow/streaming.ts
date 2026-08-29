/**
 * Vaulltcore Durable Execution — observable event streaming.
 *
 * Mirrors the existing web app's `@workflow/ai` chunk-index reconnection
 * pattern (`abortable-chat-transport.ts` + `chat-streaming-state.ts`), but
 * made provider-neutral. The `EventCursor` is the durable-layer abstraction:
 * a client presents a cursor (opaque, opaque-safe) and receives all events
 * after it, in sequence order.
 *
 * The cursor is an opaque string encoding `(runId, lastSequence)`. We do NOT
 * expose the raw sequence to untrusted callers — it is embedded inside the
 * base64-encoded cursor. A separate `SecureEventCursor` variant encrypts the
 * sequence when crossing an untrusted boundary.
 */

import type { DurableEvent } from "./model";

export interface EventCursor {
  /** Opaque, URL-safe cursor token. Empty/undefined → from the beginning. */
  readonly token: string;
  /** The run this cursor is scoped to. */
  readonly runId: string;
  /** The sequence number consumed so far (0 = nothing consumed yet). */
  readonly lastSequence: number;
}

/**
 * Encode a cursor token as `base64("<runId>:<seq>")`. The consumer cannot
 * tamper with the sequence without invalidating the format.
 */
export function encodeCursor(runId: string, lastSequence: number): string {
  const raw = `${runId}:${lastSequence}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function decodeCursor(token: string): EventCursor | undefined {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf(":");
    if (sep === -1) return undefined;
    const runId = decoded.slice(0, sep);
    const lastSequence = Number.parseInt(decoded.slice(sep + 1), 10);
    if (Number.isNaN(lastSequence) || !runId) return undefined;
    return { token, runId, lastSequence };
  } catch {
    return undefined;
  }
}

/**
 * Apply a cursor to an event list, returning events strictly after the
 * cursor's sequence, in order. This is the core replay operation used both by
 * the streaming cursor and by recovery (resume-from-checkpoint).
 */
export function applyCursor(
  events: readonly DurableEvent[],
  cursor: EventCursor | undefined,
): { events: DurableEvent[]; nextCursor: string } {
  const startAt = cursor ? cursor.lastSequence : 0;
  const filtered = events.filter((e) => e.sequence > startAt);
  const last = filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
  const nextCursor = last
    ? encodeCursor(cursor?.runId ?? "unknown", last.sequence)
    : (cursor?.token ?? "");
  return { events: filtered, nextCursor };
}

/**
 * Options for a streaming subscription.
 */
export interface StreamOptions {
  /** Tenant scoping for auth. */
  readonly tenantId: string;
  /** The run (job) to stream events for. */
  readonly runId: string;
  /** Resume cursor, if reconnecting. */
  readonly cursor?: string;
  /** Abort signal for the client disconnecting. */
  readonly signal?: AbortSignal;
}

/**
 * A batched page of streamed events, with a resumption cursor.
 */
export interface EventPage {
  readonly events: readonly DurableEvent[];
  readonly nextCursor: string;
  readonly isLast: boolean;
}
