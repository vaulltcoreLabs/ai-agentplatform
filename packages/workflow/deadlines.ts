/**
 * Vaulltcore Durable Execution — hierarchical deadlines & budget tracking.
 *
 * A run carries a `RunBudget` (max runtime, model/tool calls, tokens). The
 * deadline manager enforces two kinds of limits:
 *
 *  1. **Time deadline** — `deadlineAt` is a wall-clock ceiling; once exceeded
 *     the run is moved to `expired`.
 *  2. **Usage budget** — counters for model calls, tool calls, and tokens are
 *     tracked against the budget; breaching any counter marks the run as
 *     `failed` (budget exhaustion, not expiry).
 *
 * Deadlines are *hierarchical*: a task/step deadline cannot exceed its
 * parent run deadline. The budget tracker is the single source of truth for
 * the intelligence layer's `BudgetTracker`; Phase 3 budget events are
 * translated into durable `DurableEvent`s here.
 */

import type { RunBudget } from "./model";

export interface BudgetBreach {
  readonly kind:
    | "runtime"
    | "model_calls"
    | "tool_calls"
    | "input_tokens"
    | "output_tokens";
  readonly limit: number;
  readonly observed: number;
  readonly message: string;
}

export interface BudgetState {
  /** Epoch ms the run started. */
  readonly startedAt: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Create the initial budget state for a run.
 */
export function initialBudget(startedAt: number): BudgetState {
  return {
    startedAt,
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

/**
 * Check whether the current usage breaches any budget limit. Returns the
 * first breach found (deterministic order), or undefined if within budget.
 */
export function checkBudget(
  state: BudgetState,
  budget: RunBudget,
  now: number,
): BudgetBreach | undefined {
  const runtime = now - state.startedAt;
  if (runtime > budget.maxRuntimeMs) {
    return {
      kind: "runtime",
      limit: budget.maxRuntimeMs,
      observed: runtime,
      message: "Run exceeded max runtime",
    };
  }
  if (state.modelCalls > budget.maxModelCalls) {
    return {
      kind: "model_calls",
      limit: budget.maxModelCalls,
      observed: state.modelCalls,
      message: "Run exceeded max model calls",
    };
  }
  if (state.toolCalls > budget.maxToolCalls) {
    return {
      kind: "tool_calls",
      limit: budget.maxToolCalls,
      observed: state.toolCalls,
      message: "Run exceeded max tool calls",
    };
  }
  if (state.inputTokens > budget.maxInputTokens) {
    return {
      kind: "input_tokens",
      limit: budget.maxInputTokens,
      observed: state.inputTokens,
      message: "Run exceeded max input tokens",
    };
  }
  if (state.outputTokens > budget.maxOutputTokens) {
    return {
      kind: "output_tokens",
      limit: budget.maxOutputTokens,
      observed: state.outputTokens,
      message: "Run exceeded max output tokens",
    };
  }
  return undefined;
}

/**
 * Check whether a run/step deadline has been exceeded by wall-clock time.
 * Returns true if the deadline has passed.
 */
export function isDeadlineExceeded(
  deadlineAt: number | undefined,
  now: number,
): boolean {
  return deadlineAt !== undefined && now >= deadlineAt;
}

/**
 * Compute a child deadline from a parent deadline and a maximum child
 * duration. The child deadline is the earlier of (parent, now + duration).
 * If the parent is already expired, returns undefined (do not schedule).
 */
export function childDeadline(
  parentDeadlineAt: number | undefined,
  durationMs: number,
  now: number,
): number | undefined {
  if (parentDeadlineAt !== undefined && now >= parentDeadlineAt) {
    return undefined;
  }
  const own = now + durationMs;
  if (parentDeadlineAt !== undefined && own > parentDeadlineAt) {
    return parentDeadlineAt;
  }
  return own;
}

/**
 * Compute the run deadline from the budget's max runtime.
 */
export function computeRunDeadline(
  budget: RunBudget,
  startedAt: number,
): number {
  return startedAt + budget.maxRuntimeMs;
}
