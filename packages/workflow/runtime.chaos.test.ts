/* eslint-disable max-classes-per-file */
import { describe, expect, it, mock } from "bun:test";
import {
  DurableWorkflowRuntime,
  NoopStepExecutor,
  SubmissionValidationError,
  type DurableRuntimeDeps,
} from "./runtime";
import {
  InMemoryWorkflowStore,
  InMemoryTaskLeaseStore,
  InMemoryEventStore,
  InMemoryCheckpointStore,
  InMemoryIdempotencyStore,
  InMemoryQueue,
  TestClock,
} from "./stores";
import type { StepExecutor, StepResult } from "./contracts";
import type { StepExecution } from "./model";
import type {
  VerificationBackend,
  VerificationContext,
  VerificationResult,
  CheckSpec,
} from "@vaulltcore/intelligence";
import type { Sandbox } from "@vaulltcore/sandbox";

const TENANT = "tenant_chaos";

function makeDeps(
  executor?: StepExecutor,
  clock?: TestClock,
  extras?: Partial<Omit<DurableRuntimeDeps, "executor" | "clock">>,
): DurableRuntimeDeps {
  return {
    store: new InMemoryWorkflowStore(clock ?? new TestClock(1_000_000)),
    leases: new InMemoryTaskLeaseStore(clock ?? new TestClock(1_000_000)),
    events: new InMemoryEventStore(clock ?? new TestClock(1_000_000)),
    checkpoints: new InMemoryCheckpointStore(),
    queue: new InMemoryQueue(),
    clock: clock ?? new TestClock(1_000_000),
    executor: executor ?? new NoopStepExecutor(),
    idempotency: new InMemoryIdempotencyStore(),
    ...extras,
  };
}

class CountingExecutor implements StepExecutor {
  public calls = 0;
  async execute(
    _execution: StepExecution,
    _signal: AbortSignal,
  ): Promise<StepResult> {
    this.calls++;
    return {
      output: { ok: true, count: this.calls },
      usage: { modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 10 },
      artifacts: [],
    };
  }
}

/** Returns an error result (retryable=true) for the first N calls, then succeeds. */
class RetryableErrorExecutor implements StepExecutor {
  public calls = 0;
  constructor(private readonly failTimes: number) {}
  async execute(
    _execution: StepExecution,
    _signal: AbortSignal,
  ): Promise<StepResult> {
    this.calls++;
    if (this.calls <= this.failTimes) {
      return {
        output: null,
        usage: {},
        error: {
          failureClass: "sandbox",
          retryable: true,
          message: `transient failure ${this.calls}`,
          createdAt: Date.now(),
        },
        artifacts: [],
      };
    }
    return {
      output: { ok: true, recovered: true },
      usage: { modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 10 },
      artifacts: [],
    };
  }
}

/** Throws on the first N calls, then succeeds. */
class ThrowingCrashExecutor implements StepExecutor {
  public calls = 0;
  constructor(private readonly failTimes: number) {}
  async execute(
    _execution: StepExecution,
    _signal: AbortSignal,
  ): Promise<StepResult> {
    this.calls++;
    if (this.calls <= this.failTimes) {
      throw new Error("executor process crashed");
    }
    return {
      output: { ok: true, recovered: true },
      usage: { modelCalls: 1, toolCalls: 0, inputTokens: 10, outputTokens: 10 },
      artifacts: [],
    };
  }
}

function makePassingVerifier(): VerificationBackend {
  return {
    verify: mock(
      async (
        _ctx: VerificationContext,
        _checks: readonly CheckSpec[],
      ): Promise<VerificationResult> => ({
        passed: true,
        evidence: [],
        confidence: 0.95,
        failedChecks: [],
      }),
    ),
  };
}

function makeFailingVerifier(): VerificationBackend {
  return {
    verify: mock(
      async (
        _ctx: VerificationContext,
        _checks: readonly CheckSpec[],
      ): Promise<VerificationResult> => ({
        passed: false,
        evidence: [
          {
            name: "tests-failed",
            passed: false,
            detail: "1 test failed",
            severity: "error",
          },
        ],
        confidence: 0.8,
        failedChecks: ["tests-failed"],
      }),
    ),
  };
}

function makeThrowingVerifier(): VerificationBackend {
  return {
    verify: mock(async () => {
      throw new Error("verifier crashed");
    }),
  };
}

function makeMockSandbox(): Sandbox {
  return {
    type: "docker" as const,
    workingDirectory: "/workspace",
    stop: mock(async () => {}),
    exec: mock(async () => ({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    })),
    readFile: mock(async () => ""),
    readFileBuffer: mock(async () => Buffer.from("")),
    writeFile: mock(async () => {}),
    stat: mock(async () => ({
      isDirectory: () => true,
      isFile: () => false,
      size: 0,
      mtimeMs: 0,
    })),
    access: mock(async () => {}),
    mkdir: mock(async () => {}),
    readdir: mock(async () => []),
  } as unknown as Sandbox;
}

describe("Chaos & Fault Injection", () => {
  describe("executor failure & recovery", () => {
    it("retries after sandbox-class error and eventually succeeds", async () => {
      const executor = new RetryableErrorExecutor(1);
      const deps = makeDeps(executor, new TestClock(1_000_000));
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      const result = await runtime.submit({
        tenantId: TENANT,
        objective: "chaos: retryable sandbox error recovery",
        idempotencyKey: "chaos_retryable",
      });

      expect(result.status).toBe("completed");
      expect(executor.calls).toBe(2);
    });

    it("transitions to failed after 5 retries of persistent sandbox errors", async () => {
      const executor = new RetryableErrorExecutor(100); // never recovers
      const deps = makeDeps(executor, new TestClock(1_000_000));
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      const result = await runtime.submit({
        tenantId: TENANT,
        objective: "chaos: persistent sandbox error",
        idempotencyKey: "chaos_persistent_err",
      });

      expect(result.status).toBe("failed");
    });

    it("transitions to failed when executor throws (crash)", async () => {
      const executor = new ThrowingCrashExecutor(100);
      const deps = makeDeps(executor, new TestClock(1_000_000));
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      const result = await runtime.submit({
        tenantId: TENANT,
        objective: "chaos: executor always crashes",
        idempotencyKey: "chaos_crash_persist",
      });

      expect(result.status).toBe("failed");
    });
  });

  describe("verification failure (failing verifier)", () => {
    it("transitions to failed when verification detects test failures", async () => {
      const executor = new CountingExecutor();
      const deps = makeDeps(executor, new TestClock(1_000_000), {
        sandboxSupplier: async () => makeMockSandbox(),
        verifier: makeFailingVerifier(),
      });
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      const result = await runtime.submit({
        tenantId: TENANT,
        objective: "chaos: verification failure",
        idempotencyKey: "chaos_verify_fail",
      });

      expect(result.status).toBe("failed");
    });

    it("transitions to completed when verification passes", async () => {
      const executor = new CountingExecutor();
      const deps = makeDeps(executor, new TestClock(1_000_000), {
        sandboxSupplier: async () => makeMockSandbox(),
        verifier: makePassingVerifier(),
      });
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      const result = await runtime.submit({
        tenantId: TENANT,
        objective: "chaos: verification pass",
        idempotencyKey: "chaos_verify_pass",
      });

      expect(result.status).toBe("completed");
    });
  });

  describe("verification crash (throwing verifier)", () => {
    it("transitions to failed when verifier throws", async () => {
      const executor = new CountingExecutor();
      const deps = makeDeps(executor, new TestClock(1_000_000), {
        sandboxSupplier: async () => makeMockSandbox(),
        verifier: makeThrowingVerifier(),
      });
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      const result = await runtime.submit({
        tenantId: TENANT,
        objective: "chaos: verifier crash",
        idempotencyKey: "chaos_verify_crash",
      });

      expect(result.status).toBe("failed");
      expect(result.status).not.toBe("completed");
    });
  });

  describe("sandbox stop failure during cleanup", () => {
    it("still cleans up and transitions to completed even if sandbox.stop() throws", async () => {
      const badSandbox = {
        type: "docker" as const,
        workingDirectory: "/workspace",
        stop: mock(async () => {
          throw new Error("stop failed");
        }),
        exec: mock(async () => ({
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          truncated: false,
        })),
      } as unknown as Sandbox;

      const executor = new CountingExecutor();
      const deps = makeDeps(executor, new TestClock(1_000_000), {
        sandboxSupplier: async () => badSandbox,
        verifier: makePassingVerifier(),
      });
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      const result = await runtime.submit({
        tenantId: TENANT,
        objective: "chaos: stop failure cleanup",
        idempotencyKey: "chaos_stop_fail",
      });

      expect(result.status).toBe("completed");
    });
  });

  describe("delayed sandbox provisioning", () => {
    it("provisions sandbox with simulated delay and still completes", async () => {
      const delay = 100;
      const sandboxSupplier = mock(async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return makeMockSandbox();
      });

      const executor = new CountingExecutor();
      const deps = makeDeps(executor, new TestClock(1_000_000), {
        sandboxSupplier,
        verifier: makePassingVerifier(),
      });
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      const result = await runtime.submit({
        tenantId: TENANT,
        objective: "chaos: delayed provisioning",
        idempotencyKey: "chaos_delayed",
      });

      expect(result.status).toBe("completed");
      expect(sandboxSupplier).toHaveBeenCalledTimes(1);
    });
  });

  describe("idempotency under fault conditions", () => {
    it("returns prior result on duplicate submission with same idempotency key", async () => {
      const executor = new CountingExecutor();
      const deps = makeDeps(executor, new TestClock(1_000_000));
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      const r1 = await runtime.submit({
        tenantId: TENANT,
        objective: "idempotent objective",
        idempotencyKey: "dedup_key",
      });

      const r2 = await runtime.submit({
        tenantId: TENANT,
        objective: "idempotent objective",
        idempotencyKey: "dedup_key",
      });

      expect(r1.jobId).toBe(r2.jobId);
      expect(executor.calls).toBe(1);
    });

    it("creates separate runs for same objective with different idempotency keys", async () => {
      const executor = new CountingExecutor();
      const deps = makeDeps(executor, new TestClock(1_000_000));
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      const r1 = await runtime.submit({
        tenantId: TENANT,
        objective: "objective A",
        idempotencyKey: "key_A",
      });

      const r2 = await runtime.submit({
        tenantId: TENANT,
        objective: "objective A",
        idempotencyKey: "key_B",
      });

      // Same objective produces same jobId (content-addressable)
      expect(r1.jobId).toBe(r2.jobId);
      // But both runs execute since different idempotency keys
      expect(executor.calls).toBe(2);
    });
  });

  describe("submission validation", () => {
    it("rejects empty objective", async () => {
      const deps = makeDeps();
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      await expect(
        runtime.submit({ tenantId: TENANT, objective: "" }),
      ).rejects.toThrow(SubmissionValidationError);
    });

    it("rejects whitespace-only objective", async () => {
      const deps = makeDeps();
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      await expect(
        runtime.submit({ tenantId: TENANT, objective: "   " }),
      ).rejects.toThrow(SubmissionValidationError);
    });

    it("rejects null objective", async () => {
      const deps = makeDeps();
      const runtime = new DurableWorkflowRuntime(deps, TENANT);

      await expect(
        runtime.submit({
          tenantId: TENANT,
          objective: null as unknown as string,
        }),
      ).rejects.toThrow(SubmissionValidationError);
    });
  });
});
