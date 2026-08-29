/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "bun:test";
import {
  DefaultVerifier,
  type CheckSpec,
  type VerificationContext,
} from "./verification";
import type { TaskOutcome } from "./job-model";

const NoopSandbox = {
  exec: async () => ({
    success: true,
    exitCode: 0,
    stdout: "all good",
    stderr: "",
  }),
} as any;

const FakeSandboxFail = {
  exec: async () => ({
    success: false,
    exitCode: 1,
    stdout: "FAIL test",
    stderr: "FAIL",
  }),
} as any;

function makeOutcome(taskId = "t1", success = true): TaskOutcome {
  return {
    taskId,
    status: success ? "completed" : "failed",
    success,
    attempts: 1,
    output: success ? { result: "done" } : undefined,
  };
}

describe("verification", () => {
  it("passes when all checks pass", async () => {
    const verifier = new DefaultVerifier();
    const ctx: VerificationContext = {
      sandbox: NoopSandbox,
      workingDirectory: "/tmp",
      outcome: makeOutcome(),
      requirements: [],
      signal: undefined,
    };
    const result = await verifier.verify(ctx);
    expect(result.passed).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("fails when a check fails", async () => {
    const verifier = new DefaultVerifier();
    const ctx: VerificationContext = {
      sandbox: FakeSandboxFail,
      workingDirectory: "/tmp",
      outcome: makeOutcome(),
      requirements: [],
      signal: undefined,
    };
    const result = await verifier.verify(ctx);
    expect(result.passed).toBe(false);
    expect(result.failedChecks.length).toBeGreaterThan(0);
  });

  it("recommends a repair specialist", async () => {
    const verifier = new DefaultVerifier([
      {
        name: "always-fail",
        severity: "error",
        async run() {
          return [
            {
              name: "tests-pass",
              passed: false,
              detail: "tests failed",
              severity: "error",
            },
          ];
        },
      },
    ]);
    const ctx: VerificationContext = {
      sandbox: undefined,
      workingDirectory: "/tmp",
      outcome: makeOutcome(),
      requirements: [],
    };
    const result = await verifier.verify(ctx);
    expect(result.passed).toBe(false);
    expect(result.recommendedRepair).toBeDefined();
    expect(result.recommendedRepair!.specialist).toBe("tester");
  });

  it("confidence decreases with warnings", async () => {
    const verifier = new DefaultVerifier([
      {
        name: "warn-only",
        severity: "warning",
        async run() {
          return [
            {
              name: "lint",
              passed: false,
              detail: "lint issue",
              severity: "warning",
            },
          ];
        },
      },
    ]);
    const ctx: VerificationContext = {
      sandbox: undefined,
      workingDirectory: "/tmp",
      outcome: makeOutcome(),
      requirements: [],
    };
    const result = await verifier.verify(ctx);
    expect(result.passed).toBe(true); // warnings don't fail
    expect(result.confidence).toBeLessThan(1);
  });

  it("handles no sandbox gracefully", async () => {
    const verifier = new DefaultVerifier();
    const ctx: VerificationContext = {
      sandbox: undefined,
      workingDirectory: "/tmp",
      outcome: makeOutcome(),
      requirements: [],
    };
    const result = await verifier.verify(ctx);
    expect(result.passed).toBe(false);
    expect(result.failedChecks.some((f) => f === "tests-pass")).toBe(true);
  });

  it("records evidence", async () => {
    const verifier = new DefaultVerifier();
    const ctx: VerificationContext = {
      sandbox: NoopSandbox,
      workingDirectory: "/tmp",
      outcome: makeOutcome(),
      requirements: [],
      signal: undefined,
    };
    const result = await verifier.verify(ctx);
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("runs checks concurrently (parallel verification)", async () => {
    let active = 0;
    let maxConcurrent = 0;

    const slowCheck: CheckSpec = {
      name: "slow-check",
      severity: "error",
      async run() {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active--;
        return [
          {
            name: "slow-check",
            passed: true,
            detail: "ok",
            severity: "info",
          },
        ];
      },
    };

    const verifier = new DefaultVerifier([slowCheck, slowCheck, slowCheck]);
    const ctx: VerificationContext = {
      sandbox: undefined,
      workingDirectory: "/tmp",
      outcome: makeOutcome(),
      requirements: [],
    };
    const result = await verifier.verify(ctx);
    expect(result.passed).toBe(true);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });
});
