/**
 * Vaulltcore Durable Execution — durable statuses & state machine.
 *
 * Phase 4 introduces a durable execution state machine that is a *superset* of
 * the Phase 3 intelligence statuses. The Phase 3 `JobStatus` / `TaskStatus`
 * describe the engineering *intent* (planning, verifying, repairing). The
 * Phase 4 durable statuses additionally describe the *execution mechanics* that
 * only matter when work must survive crashes: queuing, leasing, retrying,
 * pausing, expiration.
 *
 * Mapping (durable → phase-3 equivalent where they overlap):
 *
 *   CREATED       → pending         (job exists, not yet scheduled)
 *   QUEUED        → (new)           (ready, awaiting a worker lease)
 *   RUNNING       → running
 *   WAITING       → (new)           (blocked awaiting a child event/step)
 *   PAUSED        → (new)           (operator-intended suspension)
 *   RETRYING      → blocked         (backoff before next attempt)
 *   VERIFYING     → verifying
 *   COMPLETED     → completed
 *   FAILED        → failed
 *   CANCEL_REQUESTED → (new)        (cancellation persisted, draining)
 *   CANCELLED     → cancelled
 *   EXPIRED       → (new)           (deadline exceeded before completion)
 *
 * INVALID transitions are rejected by `canTransition`. Every transition is also
 * guarded by a monotonic `version` (compare-and-swap) at the store layer.
 */

import type { JobStatus, TaskStatus } from "@vaulltcore/intelligence";

export type RunStatus =
  | "created"
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "retrying"
  | "verifying"
  | "completed"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "expired";

export type StepStatus =
  | "created"
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "cancel_requested"
  | "expired";

/** Whether the durable status represents a terminal condition. */
export function isTerminal(status: RunStatus | StepStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  );
}

/** Whether the durable status represents an active (non-terminal, non-idle) condition. */
export function isActive(status: RunStatus | StepStatus): boolean {
  return status === "running" || status === "waiting";
}

/** Valid source states for a durable step. */
const VALID_STEP_TRANSITIONS: Readonly<Record<StepStatus, StepStatus[]>> = {
  created: ["queued", "cancelled", "failed", "expired"],
  queued: ["running", "cancelled", "failed", "expired"],
  running: ["completed", "failed", "cancelled", "waiting", "cancel_requested"],
  waiting: ["running", "completed", "failed", "cancelled", "cancel_requested"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
  cancel_requested: ["cancelled", "completed", "failed", "expired"],
  expired: [],
};

/** Valid source states for a durable run. */
const VALID_RUN_TRANSITIONS: Readonly<Record<RunStatus, RunStatus[]>> = {
  created: ["queued", "failed", "cancelled", "expired"],
  queued: ["running", "failed", "cancelled", "expired", "paused"],
  running: [
    "verifying",
    "failed",
    "cancelled",
    "cancel_requested",
    "waiting",
    "paused",
  ],
  waiting: ["running", "failed", "cancelled", "cancel_requested"],
  paused: ["running", "failed", "cancelled", "expired"],
  retrying: ["queued", "failed", "cancelled", "expired"],
  verifying: ["completed", "failed", "cancel_requested", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancel_requested: ["cancelled", "completed", "failed", "expired"],
  cancelled: [],
  expired: [],
};

/** Whether a run-level state transition is permitted by the durable state machine. */
export function runCanTransition(from: RunStatus, to: RunStatus): boolean {
  return VALID_RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Whether a step-level state transition is permitted by the durable state machine. */
export function stepCanTransition(from: StepStatus, to: StepStatus): boolean {
  return VALID_STEP_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Bridge a durable run status back to the closest Phase 3 `JobStatus`, so the
 * intelligence layer's `canTransition` guard remains the source of truth for
 * engineering-level transitions. Returns `undefined` when no Phase 3
 * equivalent exists (purely durability states like `retrying`, `expired`).
 */
export function runStatusToPhase3Status(
  status: RunStatus,
): JobStatus | undefined {
  switch (status) {
    case "created":
      return "pending";
    case "running":
      return "running";
    case "verifying":
      return "verifying";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "cancel_requested":
      return "cancelled";
    default:
      return undefined;
  }
}

/**
 * Bridge a durable step status back to the closest Phase 3 `TaskStatus`.
 */
export function stepStatusToPhase3Status(
  status: StepStatus,
): TaskStatus | undefined {
  switch (status) {
    case "queued":
      return "ready";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "waiting":
      return "blocked";
    default:
      return undefined;
  }
}
