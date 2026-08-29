/**
 * Vaulltcore Agent Engine — subagent contract.
 *
 * Subagents are specialized workers, not copies of the primary agent. Each has a
 * defined responsibility, constrained tools, constrained context, an appropriate
 * model, bounded execution, and a clear output contract. The parent delegates
 * without knowing implementation details.
 *
 * Today the engine ships `explorer`, `executor`, and `design` as specialized
 * agents; this contract generalizes them so future specialists (Reviewer,
 * Debugger, Tester, Architect, ...) plug in without changing the orchestrator.
 */

import type { LanguageModelUsage } from "ai";
import type { AgentSandboxContext } from "../vaulltcore-agent";
import type { SkillMetadata } from "../skills/types";
import type { ModelSelection } from "./model-resolution";

export interface SubagentContext {
  sandbox: AgentSandboxContext;
  skills?: SkillMetadata[];
  /** Parent agent's model, used as a fallback for specialist selection. */
  parentModel?: ModelSelection | string;
}

export interface SubagentBudget {
  /** Max agentic steps before forced stop. */
  maxSteps?: number;
  /** Max output tokens. */
  maxOutputTokens?: number;
  /** Max wall-clock duration in ms. */
  maxDurationMs?: number;
}

export interface SubagentSpec {
  /** Stable role identifier, e.g. "explorer", "executor", "design". */
  role: string;
  /** Human description of the responsibility. */
  description?: string;
  /** System instructions (static or derived from context). */
  instructions: string | ((ctx: SubagentContext) => string);
  /** Model for this specialist (cheap for exploration, strong for architecture). */
  model: ModelSelection | string;
  /** Constrained tool names available to this subagent. */
  tools: string[];
  context: SubagentContext;
  /** Bounded execution. */
  budget?: SubagentBudget;
}

export interface SubagentResult<T = unknown> {
  output: T;
  usage: LanguageModelUsage;
  modelId?: string;
}

/**
 * Contract a subagent implementation fulfills. Specialists implement `run` and
 * return a normalized `SubagentResult`; usage is aggregated by the parent.
 */
export interface SubagentContract<TInput = unknown, TResult = unknown> {
  spec: SubagentSpec;
  run(input: TInput, signal?: AbortSignal): Promise<SubagentResult<TResult>>;
}

export function isSubagentResult(value: unknown): value is SubagentResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "output" in value &&
    "usage" in value
  );
}
