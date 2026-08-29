/**
 * Vaulltcore Intelligence — resource budgets & enforcement.
 *
 * Tracks consumed model calls, tool calls, tokens and runtime against an
 * `ExecutionPolicy`. The tracker is the single source of truth for "are we
 * still within budget?". Exceeding a limit is classified as a `BudgetFailure`
 * (never a silent override). Budgets are tenant-scoped and aggregated across
 * all tasks, specialists, and repair attempts within a single job.
 */

import type { ExecutionPolicy } from "./policy";
import type { FailureClass } from "./errors";

export type BudgetKind =
  | "modelCalls"
  | "toolCalls"
  | "inputTokens"
  | "outputTokens"
  | "costUSD"
  | "runtimeMs"
  | "activeAgents";

export type BudgetBreach = {
  readonly kind: BudgetKind;
  readonly consumed: number;
  readonly limit: number;
};

/**
 * Mutable, working-set snapshot of resource consumption. This is the single
 * source of truth for "are we still within budget?" — it is updated in place by
 * the `BudgetTracker` and `JobAggregate.consumeBudget`. The `JobSnapshot.budget`
 * field holds a defensive copy (spread) of this shape, so serialization is safe.
 */
export interface Budget {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  runtimeMs: number;
  activeAgents: number;
}

const ZERO_BUDGET: Budget = {
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUSD: 0,
  runtimeMs: 0,
  activeAgents: 0,
};

/** Create an empty budget (all zeros). */
export function emptyBudget(): Budget {
  return { ...ZERO_BUDGET };
}

export function cloneBudget(budget: Budget): Budget {
  return { ...budget };
}

export class BudgetTracker {
  readonly policy: ExecutionPolicy;
  readonly #consumed: Budget = { ...ZERO_BUDGET };

  constructor(policy: ExecutionPolicy) {
    this.policy = policy;
  }

  get consumed(): Budget {
    return { ...this.#consumed };
  }

  /** Current count of concurrently-running specialist agents. */
  get activeAgents(): number {
    return this.#consumed.activeAgents;
  }

  /**
   * Record a model call. Returns a breach descriptor if the policy ceiling is
   * exceeded, otherwise `undefined`.
   */
  recordModelCall(): BudgetBreach | undefined {
    this.#consumed.modelCalls += 1;
    return this.check("modelCalls");
  }

  recordToolCall(): BudgetBreach | undefined {
    this.#consumed.toolCalls += 1;
    return this.check("toolCalls");
  }

  recordTokens(input: number, output: number): BudgetBreach | undefined {
    this.#consumed.inputTokens += input;
    this.#consumed.outputTokens += output;
    let breach = this.check("inputTokens");
    if (!breach) {
      breach = this.check("outputTokens");
    }
    return breach;
  }

  recordCost(usd: number): BudgetBreach | undefined {
    this.#consumed.costUSD += usd;
    return this.check("costUSD");
  }

  recordRuntime(ms: number): BudgetBreach | undefined {
    this.#consumed.runtimeMs += ms;
    return this.check("runtimeMs");
  }

  /**
   * Increment the active-agent counter. Returns a breach if the agent ceiling
   * would be exceeded (the increment is rolled back on breach).
   */
  acquireAgent(): BudgetBreach | undefined {
    if (this.#consumed.activeAgents >= this.policy.maxAgents) {
      return {
        kind: "activeAgents",
        consumed: this.#consumed.activeAgents + 1,
        limit: this.policy.maxAgents,
      };
    }
    this.#consumed.activeAgents += 1;
    return undefined;
  }

  releaseAgent(): void {
    this.#consumed.activeAgents = Math.max(0, this.#consumed.activeAgents - 1);
  }

  private check(kind: BudgetKind): BudgetBreach | undefined {
    const consumed = this.#consumed[kind];
    const limit = this.policyLimit(kind);
    if (limit === undefined) {
      return undefined;
    }
    if (consumed > limit) {
      return { kind, consumed, limit };
    }
    return undefined;
  }

  private policyLimit(kind: BudgetKind): number | undefined {
    switch (kind) {
      case "modelCalls":
        return this.policy.maxModelCalls;
      case "toolCalls":
        return this.policy.maxToolCalls;
      case "inputTokens":
        return this.policy.maxInputTokens;
      case "outputTokens":
        return this.policy.maxOutputTokens;
      case "costUSD":
        return this.policy.maxCostUSD;
      case "runtimeMs":
        return this.policy.maxRuntimeMs;
      case "activeAgents":
        return this.policy.maxAgents;
      default:
        return undefined;
    }
  }

  /** Aggregate another snapshot into this tracker (used on resume/repair). */
  merge(snapshot: Budget): BudgetBreach | undefined {
    this.#consumed.modelCalls += snapshot.modelCalls;
    this.#consumed.toolCalls += snapshot.toolCalls;
    this.#consumed.inputTokens += snapshot.inputTokens;
    this.#consumed.outputTokens += snapshot.outputTokens;
    this.#consumed.costUSD += snapshot.costUSD;
    this.#consumed.runtimeMs += snapshot.runtimeMs;
    return (
      this.check("modelCalls") ??
      this.check("toolCalls") ??
      this.check("inputTokens") ??
      this.check("outputTokens") ??
      this.check("costUSD") ??
      this.check("runtimeMs")
    );
  }

  /**
   * Whether the job has exhausted any hard budget ceiling. Runtime is excluded
   * here because liveness (cancellation) handles it separately.
   */
  get exhausted(): boolean {
    return (
      this.check("modelCalls") !== undefined ||
      this.check("toolCalls") !== undefined ||
      this.check("inputTokens") !== undefined ||
      this.check("outputTokens") !== undefined ||
      (this.policy.maxCostUSD !== undefined &&
        this.check("costUSD") !== undefined)
    );
  }

  /** Classification for a breach — always "budget" for the failure model. */
  static breachFailureClass(_breach: BudgetBreach): FailureClass {
    return "budget";
  }
}

export function budgetExceeded(breach: BudgetBreach | undefined): boolean {
  return breach !== undefined;
}
