/**
 * Vaulltcore Durable Execution — chaos & failure injection.
 *
 * The durable layer must be testable against failures: worker crashes,
 * network partitions, and transient errors. The `ChaosInjector` is a
 * provider-neutral, in-process fault injector that the deterministic
 * `StepExecutor` (and tests) consult before acting.
 *
 * Faults are injected *deterministically* based on a seed and the step id,
 * so the same fault plan reproduces across runs. A fault plan maps
 * `(tenantId, stepId)` → failure to apply.
 */
/* eslint-disable max-classes-per-file */

import type { FailureClass } from "@vaulltcore/intelligence";
import type { Step } from "./model";

export type FaultType = "crash" | "delay" | "error" | "lease_revoke";

export interface FaultPlan {
  readonly tenantId: string;
  /** Map of step id → fault to inject. */
  readonly faults: ReadonlyMap<string, FaultSpec>;
  /** Seed for probabilistic faults (deterministic per seed). */
  readonly seed: number;
}

export interface FaultSpec {
  readonly type: FaultType;
  /** Delay in ms (for "delay" faults), or error code. */
  readonly value?: number | string;
  /** Failure class for "error" faults. */
  readonly failureClass?: FailureClass;
  /** Probability in [0, 1]. Default 1 (always). */
  readonly probability?: number;
}

export interface InjectedFailure {
  readonly type: "crash";
  readonly stepId: string;
  readonly message: string;
  /** Simulated by throwing — the process exits. */
}

export interface InjectedDelay {
  readonly type: "delay";
  readonly stepId: string;
  readonly ms: number;
}

/**
 * A no-op chaos injector that injects nothing. Use in production.
 */
export class NoopChaosInjector {
  async inspect(_step: Step): Promise<void> {}
}

/**
 * Deterministic chaos injector. Inspect a step before execution; if a fault
 * matches, apply it (delay or throw). "crash" exits the process; in tests
 * the test harness catches this by overriding `process.exit`.
 */
export class ChaosInjector {
  private readonly plans = new Map<string, FaultPlan>();

  constructor(private readonly rng: () => number = () => Math.random()) {}

  /** Install or replace a fault plan (tenant-scoped). */
  install(plan: FaultPlan): void {
    this.plans.set(plan.tenantId, plan);
  }

  uninstall(tenantId: string): void {
    this.plans.delete(tenantId);
  }

  /**
   * Inspect a step and apply any matching fault.
   * - "delay": returns a promise that resolves after `ms`.
   * - "error": throws an Error (simulating a transient failure the executor
   *   catches and classifies).
   * - "crash": throws a special `CrashError` whose message is inspected by
   *   the test harness to simulate process death.
   * - "lease_revoke": a no-op marker the runtime checks before committing.
   */
  async inspect(step: Step): Promise<void> {
    const plan = this.plans.get(step.tenantId);
    if (!plan) return;
    const spec = plan.faults.get(step.id);
    if (!spec) return;

    const prob = spec.probability ?? 1;
    if (this.rng() > prob) return;

    switch (spec.type) {
      case "delay": {
        const ms = spec.value !== undefined ? Number(spec.value) : 0;
        await new Promise((resolve) => setTimeout(resolve, ms));
        return;
      }
      case "error": {
        const code = spec.value ?? spec.failureClass ?? "chaos";
        const err = new Error(`chaos: ${code}`);
        (err as unknown as Record<string, unknown>).chaosFault = true;
        (err as unknown as Record<string, unknown>).failureClass =
          spec.failureClass ?? "unknown";
        throw err;
      }
      case "crash": {
        throw new CrashError(`chaos: process crash on step ${step.id}`);
      }
      case "lease_revoke": {
        (step as unknown as Record<string, unknown>).__chaosLeaseRevoked = true;
      }
    }
  }

  /** Whether the runtime should treat a step's lease as revoked. */
  static isLeaseRevoked(step: Step): boolean {
    return (
      (step as unknown as Record<string, unknown>)?.__chaosLeaseRevoked === true
    );
  }
}

/**
 * Special error thrown to simulate a hard process crash. The test harness
 * (or a wrapper) can catch this to simulate a restart.
 */
export class CrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrashError";
  }
}

/** Seed a simple LCG RNG for deterministic chaos plans. */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state % 1_000_000) / 1_000_000;
  };
}
