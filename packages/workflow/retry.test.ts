import { describe, expect, it } from "bun:test";
import {
  decideRetry,
  linearCongruentialRng,
  type RetryContext,
  type RetryOptions,
} from "./retry";
import { DEFAULT_EXECUTION_POLICY } from "@vaulltcore/intelligence";

const retryPolicy = DEFAULT_EXECUTION_POLICY.retry;

function makeCtx(overrides: Partial<RetryContext> = {}): RetryContext {
  return {
    attempt: 0,
    startedAt: 1000,
    deadlineAt: undefined,
    elapsedRetryMs: 0,
    failure: {
      failureClass: "model",
      retryable: true,
      message: "model down",
      createdAt: 1000,
    },
    ...overrides,
  };
}

describe("retry — decideRetry", () => {
  it("retries on transient failure", () => {
    const result = decideRetry(
      retryPolicy,
      makeCtx({ attempt: 0, startedAt: 1000 }),
      () => 0.25,
      5000,
    );
    expect(result.retry).toBe(true);
    expect(result.delayMs).toBeGreaterThan(0);
    expect(result.nextAttempt).toBe(1);
  });

  it("gives up after max retries", () => {
    const ctx = makeCtx({ attempt: retryPolicy.maxRetries });
    const result = decideRetry(retryPolicy, ctx, () => 0, 5000);
    expect(result.retry).toBe(false);
    expect(result.giveUpReason).toBe("max_attempts");
  });

  it("does not retry non-retryable failure", () => {
    const ctx = makeCtx({
      failure: {
        failureClass: "permission",
        retryable: false,
        message: "denied",
        createdAt: 1000,
      },
    });
    const result = decideRetry(retryPolicy, ctx, () => 0, 5000);
    expect(result.retry).toBe(false);
    expect(result.giveUpReason).toBe("non_retryable");
  });

  it("gives up when deadline exceeded", () => {
    const ctx = makeCtx({ deadlineAt: 5000, startedAt: 1000 });
    const result = decideRetry(retryPolicy, ctx, () => 0, 6000);
    expect(result.retry).toBe(false);
    expect(result.giveUpReason).toBe("expired");
  });

  it("applies exponential backoff", () => {
    const rng = () => 0; // no jitter
    const r0 = decideRetry(retryPolicy, makeCtx({ attempt: 0 }), rng, 5000, {
      jitter: false,
    });
    const r1 = decideRetry(retryPolicy, makeCtx({ attempt: 1 }), rng, 5000, {
      jitter: false,
    });
    // delay for attempt 1 should be 2x delay for attempt 0
    expect(r1.delayMs).toBeGreaterThan(r0.delayMs);
    expect(r1.delayMs).toBe(r0.delayMs * retryPolicy.backoffFactor);
  });

  it("respects maxDelayMs cap", () => {
    const opts: RetryOptions = { jitter: false, maxDelayMs: 100 };
    const r = decideRetry(
      retryPolicy,
      makeCtx({ attempt: 10 }),
      () => 0,
      5000,
      opts,
    );
    expect(r.delayMs).toBeLessThanOrEqual(100);
  });

  it("applies jitter that reduces delay", () => {
    const rNoJitter = decideRetry(
      retryPolicy,
      makeCtx({ attempt: 0 }),
      () => 0,
      5000,
      { jitter: false },
    );
    const rJitter = decideRetry(
      retryPolicy,
      makeCtx({ attempt: 0 }),
      () => 0.5,
      5000,
      { jitter: true },
    );
    expect(rJitter.delayMs).toBeLessThan(rNoJitter.delayMs);
  });

  it("linearCongruentialRng is deterministic", () => {
    const rng1 = linearCongruentialRng(42);
    const rng2 = linearCongruentialRng(42);
    const vals1 = [rng1(), rng1(), rng1()];
    const vals2 = [rng2(), rng2(), rng2()];
    expect(vals1).toEqual(vals2);
  });
});
