/**
 * Vaulltcore Intelligence — provider-neutral event model + event store.
 *
 * Events describe meaningful execution state. They are:
 *  - structured (typed discriminated union, no free-form strings)
 *  - versionable (`version` field; consumers skip unknown versions)
 *  - correlation-aware (`correlation` bundle per event)
 *  - tenant-aware (`tenantId` everywhere)
 *  - replayable (monotonic `sequence` per job, deterministic ordering)
 *  - safe to persist (no secrets; messages are redacted)
 *
 * These intentionally sit *beside* the Phase 1 `EngineEvent` rather than
 * replacing it: `EngineEvent` describes a single agent run; `IntelligenceEvent`
 * describes the engineering *job* lifecycle that coordinates multiple runs.
 */

import type { CorrelationId } from "./correlation";
import type {
  JobOutcome,
  JobPlanSummary,
  TaskOutcome,
  VerificationResult,
} from "./job-model";

export const INTELLIGENCE_EVENT_VERSION = "v1";

export interface IntelligenceEventBase {
  readonly version: typeof INTELLIGENCE_EVENT_VERSION;
  readonly type: string;
  readonly tenantId: string;
  readonly correlation: CorrelationId;
  readonly sequence: number;
  readonly timestamp: number;
}

type EventBody =
  | { type: "job.created"; objective: string; jobId: string }
  | { type: "job.planned"; plan: JobPlanSummary }
  | { type: "job.completed"; outcome: JobOutcome }
  | { type: "job.failed"; outcome: JobOutcome }
  | { type: "job.cancelled"; reason: string }
  | {
      type: "task.created";
      taskId: string;
      name: string;
      specialist: string;
      dependsOn: readonly string[];
    }
  | { type: "task.started"; taskId: string; specialist: string }
  | { type: "task.completed"; taskId: string; outcome: TaskOutcome }
  | { type: "task.failed"; taskId: string; outcome: TaskOutcome }
  | { type: "task.cancelled"; taskId: string; reason: string }
  | { type: "task.skipped"; taskId: string; reason: string }
  | {
      type: "agent.started";
      taskId: string;
      specialist: string;
      modelId: string;
    }
  | { type: "agent.completed"; taskId: string; usage: Record<string, number> }
  | { type: "tool.started"; taskId: string; tool: string; toolCallId: string }
  | {
      type: "tool.completed";
      taskId: string;
      tool: string;
      toolCallId: string;
      success: boolean;
    }
  | { type: "verification.started"; taskId: string }
  | { type: "verification.passed"; taskId: string; result: VerificationResult }
  | { type: "verification.failed"; taskId: string; result: VerificationResult }
  | { type: "repair.started"; taskId: string; attempt: number; reason: string }
  | {
      type: "repair.completed";
      taskId: string;
      attempt: number;
      success: boolean;
    }
  | { type: "repair.failed"; taskId: string; attempt: number; reason: string }
  | { type: "budget.breached"; kind: string; consumed: number; limit: number }
  | { type: "job.warning"; message: string };

export type IntelligenceEvent = IntelligenceEventBase & EventBody;

export type IntelligenceEventType = EventBody["type"];

/**
 * Append-only, immutable event log. Backed by any durable store in production;
 * the default implementation is an in-memory per-process log suitable for
 * tests and single-process runs. Events are immutable once appended.
 */
export interface EventLog {
  append(event: IntelligenceEventInit): Promise<IntelligenceEvent>;
  replay(jobId: string): Promise<IntelligenceEvent[]>;
  count(jobId?: string): number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DistributiveOmit<T, K extends keyof T> = T extends any
  ? Omit<T, K>
  : never;

/**
 * Shape accepted by `EventLog.append`: an event body plus the correlation /
 * tenant that the log stamps with a sequence, timestamp, and version.
 */
export type IntelligenceEventInit = DistributiveOmit<
  IntelligenceEvent,
  "version" | "sequence" | "timestamp"
>;

/** In-process append-only log. Events are frozen (immutable) once stored. */
export class MemoryEventLog implements EventLog {
  readonly #jobs = new Map<string, IntelligenceEvent[]>();
  #seq = new Map<string, number>();

  async append(event: IntelligenceEventInit): Promise<IntelligenceEvent> {
    const jobId = event.correlation.job;
    const sequence = this.#seq.get(jobId) ?? 0;
    const stamped = Object.freeze({
      ...event,
      version: INTELLIGENCE_EVENT_VERSION,
      sequence,
      timestamp: Date.now(),
    }) as IntelligenceEvent;
    const logs = this.#jobs.get(jobId) ?? [];
    logs.push(stamped);
    this.#jobs.set(jobId, logs);
    this.#seq.set(jobId, sequence + 1);
    return stamped;
  }

  async replay(jobId: string): Promise<IntelligenceEvent[]> {
    const logs = this.#jobs.get(jobId);
    if (!logs) {
      return [];
    }
    return [...logs];
  }

  count(jobId?: string): number {
    if (jobId) {
      return this.#jobs.get(jobId)?.length ?? 0;
    }
    let total = 0;
    for (const logs of this.#jobs.values()) {
      total += logs.length;
    }
    return total;
  }
}

/** Type guard: is this a real IntelligenceEvent with a known version? */
export function isIntelligenceEvent(
  value: unknown,
): value is IntelligenceEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === INTELLIGENCE_EVENT_VERSION &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { tenantId?: unknown }).tenantId === "string"
  );
}
