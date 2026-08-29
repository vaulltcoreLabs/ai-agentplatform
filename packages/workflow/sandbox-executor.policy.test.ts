/**
 * Phase 4.4 regression tests: the `securityPolicy` option of
 * `SandboxStepExecutor` must flow into the agent sandbox context so the agent
 * engine can enforce it where tools obtain their live sandbox (`getSandbox`
 * in @vaulltcore/agent tools — tools reconnect from serialized state, so
 * enforcement cannot live on a wrapper around the executor's local instance).
 *
 * Before hardening, the executor accepted a `SandboxSecurityPolicy` and
 * silently ignored it — no execution path ever consulted it.
 */

import { describe, expect, it } from "bun:test";
import { SandboxStepExecutor } from "./sandbox-executor";
import type { StepExecution } from "./model";
import {
  defaultSecurityPolicy,
  type Sandbox,
  type SandboxSecurityPolicy,
} from "@vaulltcore/sandbox";
import {
  createDurableJobId,
  createDurableRunId,
  createDurableTaskId,
  createDurableStepId,
} from "./identity";

const TENANT = "tenant_policy";

function makeIds() {
  const jobId = createDurableJobId(TENANT, "policy probe");
  const runId = createDurableRunId(jobId, 1);
  const taskId = createDurableTaskId(jobId, "main");
  const stepId = createDurableStepId(taskId, 1);
  return { jobId, runId, taskId, stepId };
}

function makeMockSandbox(workingDirectory = "/workspace"): Sandbox {
  return {
    type: "docker" as const,
    workingDirectory,
    exec: async () => ({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    }),
    readFile: async () => "",
    readFileBuffer: async () => Buffer.from(""),
    writeFile: async () => {},
    stat: async () => ({
      isDirectory: () => false,
      isFile: () => true,
      size: 0,
      mtimeMs: 0,
    }),
    access: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stop: async () => {},
    getState: () => ({ type: "docker", sandboxName: "probe" }),
  } as unknown as Sandbox;
}

function makeStepExecution(): StepExecution {
  const { jobId, runId, taskId, stepId } = makeIds();
  const now = Date.now();
  return {
    step: {
      id: stepId,
      runId,
      taskId,
      tenantId: TENANT,
      attempt: 1,
      taskIdRef: taskId,
      status: "queued",
      createdAt: now,
      version: 0,
      deadlineAt: now + 60_000,
    },
    task: {
      id: taskId,
      runId,
      jobId,
      spec: {
        id: "main",
        name: "main",
        specialist: "default",
        dependsOn: [],
        input: { task: "probe the boundary" },
      },
      status: "queued",
      attempt: 1,
      version: 0,
      completedSteps: [],
    },
    job: {
      id: jobId,
      tenantId: TENANT,
      objective: "policy probe",
      status: "running",
      runCount: 1,
      currentRunId: runId,
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    lease: {
      id: "lease_1",
      stepId,
      owner: "worker_test",
      attempt: 1,
      expiresAt: now + 60_000,
      heartbeatAt: now,
      version: 1,
      createdAt: now,
      revokedAt: null,
    },
    correlationId: runId,
    deadlineMs: 60_000,
    idempotencyKey: "idem_policy_probe",
  };
}

describe("SandboxStepExecutor — security policy flows to the agent context", () => {
  it("attaches the configured policy so getSandbox() can enforce tool I/O", async () => {
    const policy: SandboxSecurityPolicy = defaultSecurityPolicy("/workspace");
    let seenContext: unknown;

    const executor = new SandboxStepExecutor({
      sandboxSupplier: async () => makeMockSandbox("/workspace"),
      securityPolicy: policy,
      agentSupplier: () =>
        ({
          run: async (_prompt: string, options: { sandbox: unknown }) => {
            seenContext = options.sandbox;
            return { text: "ok", usage: {}, steps: 1 };
          },
        }) as never,
    });

    const result = await executor.execute(
      makeStepExecution(),
      new AbortController().signal,
    );
    expect(result.error).toBeUndefined();

    const context = seenContext as {
      workingDirectory: string;
      securityPolicy?: SandboxSecurityPolicy;
    };
    expect(context.workingDirectory).toBe("/workspace");
    expect(context.securityPolicy).toBe(policy);
  });

  it("omits the policy when none is configured (unchanged behavior)", async () => {
    let seenContext: unknown;

    const executor = new SandboxStepExecutor({
      sandboxSupplier: async () => makeMockSandbox(),
      agentSupplier: () =>
        ({
          run: async (_prompt: string, options: { sandbox: unknown }) => {
            seenContext = options.sandbox;
            return { text: "ok", usage: {}, steps: 1 };
          },
        }) as never,
    });

    await executor.execute(makeStepExecution(), new AbortController().signal);

    const context = seenContext as { securityPolicy?: SandboxSecurityPolicy };
    expect(context.securityPolicy).toBeUndefined();
  });
});
