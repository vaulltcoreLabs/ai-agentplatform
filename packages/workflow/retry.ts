/**
 * Vaulltcore Durable Execution — retry policy & backoff.
 *
 * Computes retry timing for a durable step based on the Phase 3
 * `RetryPolicy` (from `@vaulltcore/intelligence`), enriched with
 * jitter and a hard retry-attempt cap so a misbehaving task cannot
 * exhaust the run budget.
 *
 * Backoff is exponential: `backoffMs * backoffFactor^consecutiveFailures`,
 * clamped to `maxDelay`. If `jitter` is requested (default), a uniform random
 * fraction in [0, 0.5) of the computed delay is subtracted to avoid
 * synchronized retry thundering herds across workers.
 *
 * The retry engine is pure: it takes the current attempt and a policy
 * and returns either the delay before the next attempt or a terminal
 * "give up" signal. Side effects (persisting `retryAt`, queueing the
 * message) live in the runtime.
 */

import type { RetryPolicy } from "@vaulltcore/intelligence";
import type { FailureRecord } from "./model";

export const DEFAULT_MAX_DELAY_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
  readonly nextAttempt: number;
  readonly giveUpReason?: GiveUpReason;
}

export type GiveUpReason =
  | "max_attempts"
  | "max_duration"
  | "non_retryable"
  | "budget_exhausted"
  | "expired";

export interface RetryContext {
  /** Zero-based attempt number of the failed attempt. 0 = first failure. */
  readonly attempt: number;
  /** Epoch ms the step started. */
  readonly startedAt: number;
  /** Epoch ms the deadline for the whole run. */
  readonly deadlineAt?: number;
  /** Total elapsed (ms) spent on retries so far for this step. */
  readonly elapsedRetryMs: number;
  /** The failure that caused the retry decision. */
  readonly failure: FailureRecord;
}

export interface RetryOptions {
  /** Hard cap on delay (ms). Defaults to 60s. */
  readonly maxDelayMs?: number;
  /** Whether to apply jitter. Defaults to true. */
  readonly jitter?: boolean;
}

/**
 * Pure retry decision: given a policy and context, decide whether to retry.
 *
 * @param policy  The retry policy (from ExecutionPolicy.retry).
 * @param ctx     The retry context (attempt, timing, failure).
 * @param rng     Inject a deterministic RNG for reproducible tests.
 * @param now     Current epoch ms (for deadline checks).
 * @param opts    Optional overrides for max delay and jitter.
 */
export function decideRetry(
  policy: RetryPolicy,
  ctx: RetryContext,
  rng: () => number,
  now: number,
  opts: RetryOptions = {},
): RetryDecision {
  const giveUp = shouldGiveUp(policy, ctx, now);
  if (giveUp) {
    return {
      retry: false,
      delayMs: 0,
      nextAttempt: ctx.attempt + 1,
      giveUpReason: giveUp,
    };
  }

  const computed = computeBackoff(policy, ctx.attempt);
  const maxDelay = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const capped = Math.min(computed, maxDelay);
  const jittered = (opts.jitter ?? true) ? applyJitter(capped, rng) : capped;

  return {
    retry: true,
    delayMs: jittered,
    nextAttempt: ctx.attempt + 1,
  };
}

function shouldGiveUp(
  policy: RetryPolicy,
  ctx: RetryContext,
  now: number,
): GiveUpReason | undefined {
  const maxRetries = policy.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (ctx.attempt >= maxRetries) {
    return "max_attempts";
  }

  if (ctx.deadlineAt && now >= ctx.deadlineAt) {
    return "expired";
  }

  if (!ctx.failure.retryable) {
    return "non_retryable";
  }

  return undefined;
}

function computeBackoff(policy: RetryPolicy, attempt: number): number {
  const base = policy.backoffMs;
  const factor = policy.backoffFactor ?? 2;
  const exp = factor ** attempt;
  return base * exp;
}

function applyJitter(delay: number, rng: () => number): number {
  return delay * (1 - rng() * 0.5);
}

/**
 * Compute a deterministic jittered delay using a simple LCG so tests can
 * assert exact values. Pass this as the `rng` to `decideRetry` for
 * reproducible scheduling.
 */
export function linearCongruentialRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state % 1000) / 1000;
  };
}
