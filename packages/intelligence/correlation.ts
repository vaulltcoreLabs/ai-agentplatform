/**
 * Vaulltcore Intelligence — correlation identifiers.
 *
 * Every execution is traceable via a correlation bundle that flows through the
 * job, tasks, specialists, tool calls, sandbox handles, model calls, and
 * verification steps. Correlation ids are runtime-scoped (random) and distinct
 * from the deterministic job/task ids in `ids.ts`.
 *
 * These are safe to log: they carry no secrets, only opaque identifiers and a
 * tenant marker.
 */

export const INTELLIGENCE_EVENT_VERSION = "v1";

export interface CorrelationId {
  /** The tenant this execution belongs to. */
  readonly tenant: string;
  /** Deterministic job id (see `ids.createJobId`). */
  readonly job: string;
  /** Optional active task id. */
  readonly task?: string;
  /** Optional active specialist/agent run id (random). */
  readonly agent?: string;
  /** Optional active tool-call id (random). */
  readonly toolCall?: string;
  /** Optional sandbox handle id (random). */
  readonly sandbox?: string;
  /** Optional model-call id (random). */
  readonly modelCall?: string;
  /** Optional verification id (random). */
  readonly verification?: string;
}

let randomCounter = 0;

function randomId(prefix: string): string {
  // Mix crypto UUID with a process counter to guarantee uniqueness across
  // synchronous allocations within the same tick.
  const uuid = cryptoRandomId();
  randomCounter = (randomCounter + 1) & 0x7fffffff;
  return `${prefix}_${uuid}_${randomCounter}`;
}

function cryptoRandomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for exotic runtimes without crypto.randomUUID.
  const bytes = new Uint8Array(16);
  let seed = 123456789;
  for (let i = 0; i < bytes.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = seed & 0xff;
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Start a fresh correlation bundle for a job run. */
export function newCorrelation(tenant: string, job: string): CorrelationId {
  return {
    tenant,
    job,
    sandbox: randomId("sbx"),
    verification: randomId("ver"),
  };
}

/** Attach a task to a correlation bundle, returning a child bundle. */
export function withTask(
  correlation: CorrelationId,
  task: string,
  overrides?: Partial<Omit<CorrelationId, "tenant" | "job">>,
): CorrelationId {
  return {
    ...correlation,
    task,
    agent: overrides?.agent ?? randomId("agt"),
    toolCall: overrides?.toolCall,
    modelCall: overrides?.modelCall ?? randomId("mdl"),
  };
}

/** Produce a correlation bundle for a standalone verification step. */
export function verificationCorrelation(
  correlation: CorrelationId,
): CorrelationId {
  return {
    ...correlation,
    verification: randomId("ver"),
  };
}
