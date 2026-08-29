/**
 * Vaulltcore Durable Execution — durable cancellation.
 *
 * Cancellation in a distributed system is not a single flag — it is a
 * propagating signal. A caller requests cancellation (which is persisted so it
 * survives a control-plane crash), and workers polling for work must:
 *
 *  1. Refuse to lease a step whose run is marked `cancel_requested`.
 *  2. Abort an in-flight step when the cancellation signal arrives (via the
 *     `AbortSignal` passed to `StepExecutor.execute`).
 *
 * This module provides the in-memory `CancellationHub`: a tenant-scoped
 * registry of `AbortController`s keyed by durable run id. The persistence
 * layer (`WorkflowStore`) records the durable marker; the hub wires the
 * marker to live in-process controllers.
 */

import type { DurableRunId, TenantId, WorkerId } from "./identity";

export interface CancellationState {
  /** The durable run id being cancelled. */
  readonly runId: DurableRunId;
  readonly tenantId: TenantId;
  /** Who requested it. */
  readonly requestedBy: string;
  /** Why. */
  readonly reason: string;
  /** Epoch ms. */
  readonly requestedAt: number;
}

/**
 * Tenant-isolated in-memory cancellation registry.
 *
 * In a multi-process deployment this would be backed by a pub/sub or database
 * trigger; the contract remains: publish a durable cancellation and have
 * every worker's local controllers fire.
 */
export class CancellationHub {
  private readonly signals = new Map<string, AbortController>();
  private readonly requested = new Map<string, CancellationState>();

  /**
   * Register a run so its abort signal is available to workers.
   * Called when a run is created or resumed.
   */
  register(runId: DurableRunId, tenantId: TenantId): AbortSignal {
    const key = `${tenantId}:${runId}`;
    let controller = this.signals.get(key);
    if (!controller) {
      controller = new AbortController();
      this.signals.set(key, controller);
    }
    return controller.signal;
  }

  /**
   * Persisted cancellation: mark the run as cancelled and fire the signal.
   * Safe to call multiple times (idempotent).
   */
  cancel(
    runId: DurableRunId,
    tenantId: TenantId,
    requestedBy: string,
    reason: string,
    now: number,
  ): void {
    const key = `${tenantId}:${runId}`;
    if (!this.requested.has(key)) {
      this.requested.set(key, {
        runId,
        tenantId,
        requestedBy,
        reason,
        requestedAt: now,
      });
    }
    const controller = this.signals.get(key);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
  }

  /** Whether a cancellation has been requested for this run. */
  isCancelled(runId: DurableRunId, tenantId: TenantId): boolean {
    return this.requested.has(`${tenantId}:${runId}`);
  }

  /** The cancellation record, if any. */
  get(runId: DurableRunId, tenantId: TenantId): CancellationState | undefined {
    return this.requested.get(`${tenantId}:${runId}`);
  }

  /** Release the in-process controller and forget the cancellation record. */
  unregister(runId: DurableRunId, tenantId: TenantId): void {
    const key = `${tenantId}:${runId}`;
    this.signals.delete(key);
    this.requested.delete(key);
  }

  /**
   * Create a child signal that also respects a per-step deadline and a
   * parent abort signal, so `StepExecutor.execute` gets a single signal
   * combining run-cancellation + step-deadline + worker-initiated cancel.
   */
  childSignal(
    runId: DurableRunId,
    tenantId: TenantId,
    worker: WorkerId,
    deadlineAt: number | undefined,
    clockNow: number,
  ): { signal: AbortSignal; timer: TimerHandle } {
    const parent = this.signals.get(`${tenantId}:${runId}`);
    const controller = new AbortController();
    const timer = createDeadlineTimer(deadlineAt, clockNow, controller);
    if (parent) {
      if (parent.signal.aborted) {
        controller.abort();
      } else {
        const target = parent.signal as unknown as EventTarget;
        target.addEventListener("abort", () => controller.abort());
      }
    }
    return { signal: controller.signal, timer };
  }
}

/** Minimal timer handle so we can clean up without depending on setTimeout IDs. */
export interface TimerHandle {
  clear(): void;
}

function createDeadlineTimer(
  deadlineAt: number | undefined,
  now: number,
  controller: AbortController,
): TimerHandle {
  if (deadlineAt === undefined) {
    return { clear: () => {} };
  }
  const remaining = deadlineAt - now;
  if (remaining <= 0) {
    controller.abort();
    return { clear: () => {} };
  }
  const id = setTimeout(() => controller.abort(), remaining);
  return { clear: () => clearTimeout(id) };
}
