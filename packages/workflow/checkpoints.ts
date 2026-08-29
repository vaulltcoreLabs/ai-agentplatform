/**
 * Vaulltcore Durable Execution — checkpoint lifecycle.
 *
 * Checkpoints capture the recoverable state of a step at a durable boundary.
 * They are append-only within a step (sequence-monotonic) and content-derived
 * so that a crash + recovery produces the same resume point.
 *
 * This module provides helpers to:
 *  - `createCheckpoint`: build a checkpoint from partial executor state.
 *  - `deriveResumePoint`: the highest-sequence checkpoint (or null).
 *  - `mergeCheckpoints`: combine evidence from multiple checkpoints (used by
 *    the repair loop to reconstruct a complete evidence set after a retry).
 */

import { createHash } from "node:crypto";
import type { Checkpoint } from "./model";
import type { DurableStepId } from "./identity";

/**
 * Build a checkpoint from partial executor state. The `id` is deterministic:
 * derived from (stepId, sequence) so the same resume point is stable across
 * process restarts.
 */
export function createCheckpoint(
  stepId: DurableStepId,
  sequence: number,
  state: Record<string, unknown>,
  evidence: readonly string[],
  attempt: number,
  createdAt: number,
  runId: string,
  taskId: string,
): Checkpoint {
  return {
    id: hashCheckpointId(stepId, sequence),
    runId,
    taskId,
    stepId,
    sequence,
    state,
    evidence: [...evidence],
    attempt,
    createdAt,
  };
}

function hashCheckpointId(stepId: string, sequence: number): string {
  return `ckpt_${createHash("sha256").update(`${stepId}:${sequence}`).digest("hex").slice(0, 16)}`;
}

/**
 * Derive the resume point for a step: the highest-sequence checkpoint,
 * or `null` if none exists.
 */
export function deriveResumePoint(
  checkpoints: readonly Checkpoint[],
): Checkpoint | null {
  if (checkpoints.length === 0) return null;
  let latest: Checkpoint = checkpoints[0]!;
  for (const cp of checkpoints) {
    if (cp.sequence > latest.sequence) {
      latest = cp;
    }
  }
  return latest;
}

/**
 * Merge evidence references from all checkpoints of a step into a single
 * deduplicated, ordered list. Used by the repair loop to know what evidence
 * is already available.
 */
export function mergeEvidence(
  checkpoints: readonly Checkpoint[],
): readonly string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const cp of checkpoints) {
    for (const ref of cp.evidence) {
      if (!seen.has(ref)) {
        seen.add(ref);
        merged.push(ref);
      }
    }
  }
  return merged;
}

/**
 * Whether a checkpoint at `sequence` is the latest for its step.
 */
export function isLatestCheckpoint(
  checkpoint: Checkpoint,
  checkpoints: readonly Checkpoint[],
): boolean {
  const latest = deriveResumePoint(checkpoints);
  return latest !== null && latest.sequence === checkpoint.sequence;
}

/**
 * Extract the highest attempt number from a step's checkpoint history.
 */
export function highestAttempt(checkpoints: readonly Checkpoint[]): number {
  if (checkpoints.length === 0) return 0;
  return Math.max(...checkpoints.map((cp) => cp.attempt));
}
