/**
 * Vaulltcore Intelligence — execution policy.
 *
 * System-safety boundaries. Policies are configurable by tenant / job /
 * environment, but system defaults are never silently overridden by user
 * input. Every numeric limit is enforced by the `BudgetTracker` and the
 * scheduler; exceeding a limit produces a structured `BudgetFailure`.
 */

export type NetworkPolicy = "none" | "egress-restricted" | "full";

export type ApprovalPolicy = "auto-unsafe" | "manual-required" | "deny";

export interface RetryPolicy {
  /** Max automated repair/retry attempts for a failed task. */
  readonly maxRepairAttempts: number;
  /** Max retries for transient (retryable) failures. */
  readonly maxRetries: number;
  /** Base backoff in ms for retry scheduling. */
  readonly backoffMs: number;
  /** Multiplier applied to backoff between successive attempts. */
  readonly backoffFactor: number;
}

export interface ExecutionPolicy {
  /** Maximum subagent nesting depth. Prevents recursive delegation loops. */
  readonly maxDepth: number;
  /** Maximum number of concurrent specialist agents. */
  readonly maxAgents: number;
  /** Maximum number of tasks executing in parallel. */
  readonly maxParallelism: number;
  /** Maximum model requests for the whole job. */
  readonly maxModelCalls: number;
  /** Maximum tool invocations for the whole job. */
  readonly maxToolCalls: number;
  /** Maximum wall-clock runtime for the whole job (ms). */
  readonly maxRuntimeMs: number;
  /** Hard ceiling on total input tokens (approximate). */
  readonly maxInputTokens: number;
  /** Hard ceiling on total output tokens (approximate). */
  readonly maxOutputTokens: number;
  /** Optional hard ceiling on spend (USD). */
  readonly maxCostUSD?: number;
  /** Network egress policy enforced by the sandbox runtime. */
  readonly network: NetworkPolicy;
  /** Approval policy for risky tool use. */
  readonly approval: ApprovalPolicy;
  /** Capabilities a task must be allowed to use (e.g. "fs-write"). */
  readonly allowedCapabilities: string[];
  /** Retry / repair behavior. */
  readonly retry: RetryPolicy;
}

export const DEFAULT_MAX_DEPTH = 5;
export const DEFAULT_MAX_AGENTS = 32;
export const DEFAULT_MAX_PARALLELISM = 4;
export const DEFAULT_MAX_MODEL_CALLS = 1000;
export const DEFAULT_MAX_TOOL_CALLS = 2000;
export const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
export const DEFAULT_MAX_INPUT_TOKENS = 500_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 200_000;

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  maxDepth: DEFAULT_MAX_DEPTH,
  maxAgents: DEFAULT_MAX_AGENTS,
  maxParallelism: DEFAULT_MAX_PARALLELISM,
  maxModelCalls: DEFAULT_MAX_MODEL_CALLS,
  maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
  maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
  maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  network: "egress-restricted",
  approval: "auto-unsafe",
  allowedCapabilities: ["fs-read", "fs-write", "shell", "network-restricted"],
  retry: {
    maxRepairAttempts: 3,
    maxRetries: 2,
    backoffMs: 1000,
    backoffFactor: 2,
  },
};

export type PolicyOverride = Partial<{
  maxDepth: number;
  maxAgents: number;
  maxParallelism: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxRuntimeMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUSD: number;
  network: NetworkPolicy;
  approval: ApprovalPolicy;
  allowedCapabilities: string[];
  retry: Partial<RetryPolicy>;
}>;

/**
 * Apply a tenant/policy override on top of the system defaults. User-supplied
 * values can raise limits up to the system ceilings but never exceed them.
 */
export function applyPolicyOverride(
  base: ExecutionPolicy,
  override: PolicyOverride,
): ExecutionPolicy {
  const retry: RetryPolicy = {
    ...base.retry,
    ...override.retry,
    maxRepairAttempts: Math.max(
      0,
      override.retry?.maxRepairAttempts ?? base.retry.maxRepairAttempts ?? 0,
    ),
    maxRetries: Math.max(
      0,
      override.retry?.maxRetries ?? base.retry.maxRetries ?? 0,
    ),
    backoffMs: Math.max(
      0,
      override.retry?.backoffMs ?? base.retry.backoffMs ?? 0,
    ),
    backoffFactor: Math.max(
      0,
      override.retry?.backoffFactor ?? base.retry.backoffFactor ?? 0,
    ),
  };
  return {
    maxDepth:
      override.maxDepth !== undefined
        ? Math.min(override.maxDepth, base.maxDepth)
        : base.maxDepth,
    maxAgents:
      override.maxAgents !== undefined
        ? Math.max(1, Math.min(override.maxAgents, base.maxAgents))
        : base.maxAgents,
    maxParallelism:
      override.maxParallelism !== undefined
        ? Math.min(override.maxParallelism, base.maxParallelism)
        : base.maxParallelism,
    maxModelCalls:
      override.maxModelCalls !== undefined
        ? Math.min(override.maxModelCalls, base.maxModelCalls)
        : base.maxModelCalls,
    maxToolCalls:
      override.maxToolCalls !== undefined
        ? Math.min(override.maxToolCalls, base.maxToolCalls)
        : base.maxToolCalls,
    maxRuntimeMs:
      override.maxRuntimeMs !== undefined
        ? Math.min(override.maxRuntimeMs, base.maxRuntimeMs)
        : base.maxRuntimeMs,
    maxInputTokens:
      override.maxInputTokens !== undefined
        ? Math.min(override.maxInputTokens, base.maxInputTokens)
        : base.maxInputTokens,
    maxOutputTokens:
      override.maxOutputTokens !== undefined
        ? Math.min(override.maxOutputTokens, base.maxOutputTokens)
        : base.maxOutputTokens,
    maxCostUSD:
      override.maxCostUSD !== undefined ? override.maxCostUSD : base.maxCostUSD,
    network: override.network ?? base.network,
    approval: override.approval ?? base.approval,
    allowedCapabilities:
      override.allowedCapabilities ?? base.allowedCapabilities,
    retry,
  };
}
