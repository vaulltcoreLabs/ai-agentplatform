import { describe, expect, it, mock } from "bun:test";
import {
  SandboxStepExecutor,
  SandboxExecError,
  type SandboxStepExecutorOptions,
} from "./sandbox-executor";
import type { StepExecution } from "./model";
import type { Sandbox, SandboxState } from "@vaulltcore/sandbox";
import {
  createDurableJobId,
  createDurableRunId,
  createDurableTaskId,
  createDurableStepId,
} from "./identity";

const TENANT = "tenant_test";

function makeIds(objective = "build a web server") {
  const jobId = createDurableJobId(TENANT, objective);
  const runId = createDurableRunId(jobId, 1);
  const taskId = createDurableTaskId(jobId, "coder:main");
  const stepId = createDurableStepId(taskId, 1);
  return { jobId, runId, taskId, stepId };
}

interface MockSandboxOptions {
  workingDirectory?: string;
  shouldFailStop?: boolean;
  shouldFailExec?: boolean;
}

function makeMockSandbox(opts: MockSandboxOptions = {}): Sandbox {
  const stopMock = mock(async () => {
    if (opts.shouldFailStop) {
      throw new Error("sandbox stop failed");
    }
  });
  const execMock = mock(
    async (
      _command: string,
      _cwd: string,
      _timeoutMs: number,
      _options?: { signal?: AbortSignal },
    ) => {
      if (opts.shouldFailExec) {
        return {
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: "exec error",
          truncated: false,
        };
      }
      return {
        success: true,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        truncated: false,
      };
    },
  );
  const getStateMock = mock(() => ({ type: "docker" }) as SandboxState);
  return {
    type: "docker" as const,
    workingDirectory: opts.workingDirectory ?? "/workspace",
    stop: stopMock,
    exec: execMock,
    getState: getStateMock,
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

// We use a simpler approach: build a fake agent object that matches what
interface FakeAgent {
  run: (
    prompt: string,
    options: {
      sandbox: unknown;
      abortSignal: AbortSignal;
      model?: string;
      subagentModel?: string;
    },
  ) => Promise<{ text: string; usage: unknown; steps: number }>;
}

function makeFakeAgent(impl?: {
  text?: string;
  usage?: unknown;
  steps?: number;
  throwOnRun?: (err: unknown) => void;
}): FakeAgent {
  return {
    run: mock(
      async (
        _prompt: string,
        _options: {
          sandbox: unknown;
          abortSignal: AbortSignal;
          model?: string;
          subagentModel?: string;
        },
      ) => {
        if (impl?.throwOnRun) {
          throw impl.throwOnRun(new Error("agent run failed"));
        }
        // Check for abort
        if (_options.abortSignal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return {
          text: impl?.text ?? "agent output",
          usage: impl?.usage ?? {
            totalTokens: 5,
            inputTokens: 3,
            outputTokens: 2,
          },
          steps: impl?.steps ?? 1,
        };
      },
    ),
  };
}

function makeStepExecution(
  overrides: Partial<StepExecution> = {},
): StepExecution {
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
      deadlineAt: now + 300_000,
    },
    task: {
      id: taskId,
      runId,
      jobId,
      spec: {
        id: "main",
        name: "coder",
        specialist: "coder",
        dependsOn: [],
        input: { task: "fix the bug", instructions: "check src/index.ts" },
      },
      status: "queued",
      attempt: 1,
      version: 0,
      completedSteps: [],
    },
    job: {
      id: jobId,
      tenantId: TENANT,
      objective: "build a web server",
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
    correlationId: "corr_1",
    deadlineMs: 300_000,
    idempotencyKey: "idem_step_1",
    ...overrides,
  };
}

describe("SandboxStepExecutor", () => {
  it("returns a cancellation result when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const executor = new SandboxStepExecutor({
      sandboxSupplier: async () => makeMockSandbox(),
      agentSupplier: () => makeFakeAgent() as never,
    });

    const result = await executor.execute(
      makeStepExecution(),
      controller.signal,
    );

    expect(result.error).toBeDefined();
    expect(result.error!.failureClass).toBe("cancellation");
    expect(result.error!.retryable).toBe(false);
  });

  it("successfully executes a step with sandbox and agent", async () => {
    const stopMock = makeMockSandbox();
    const agentRunMock = mock(async () => ({
      text: "done",
      usage: { totalTokens: 5, inputTokens: 3, outputTokens: 2 },
      steps: 1,
    }));
    const fakeAgent = { run: agentRunMock } as unknown as never;

    const executor = new SandboxStepExecutor({
      sandboxSupplier: async () => stopMock,
      agentSupplier: () => fakeAgent as never,
    } as SandboxStepExecutorOptions);

    const result = await executor.execute(
      makeStepExecution(),
      new AbortController().signal,
    );

    expect(result.error).toBeUndefined();
    expect(result.output).toBeDefined();
    expect((result.output as { text: string }).text).toBe("done");
    expect(result.usage).toBeDefined();
    expect(result.idempotencyKey).toBe("idem_step_1");
    expect(stopMock.stop).toHaveBeenCalled();
  });

  it("throws SandboxExecError when sandbox provisioning fails", async () => {
    const executor = new SandboxStepExecutor({
      sandboxSupplier: async () => {
        throw new Error("docker daemon unavailable");
      },
      agentSupplier: () => makeFakeAgent() as never,
    });

    await expect(
      executor.execute(makeStepExecution(), new AbortController().signal),
    ).rejects.toThrow(SandboxExecError);
  });

  it("classifies agent errors as 'tool' failure on generic error", async () => {
    const fakeAgent = makeFakeAgent({
      throwOnRun: (err) => err,
    });

    const executor = new SandboxStepExecutor({
      sandboxSupplier: async () => makeMockSandbox(),
      agentSupplier: () => fakeAgent as never,
    });

    const result = await executor.execute(
      makeStepExecution(),
      new AbortController().signal,
    );

    expect(result.error).toBeDefined();
    expect(result.error!.failureClass).toBe("tool");
    expect(result.error!.retryable).toBe(true);
    expect(result.error!.message).toContain("agent run failed");
  });

  it("classifies AbortError as cancellation", async () => {
    const fakeAgent: FakeAgent = {
      run: mock(async () => {
        throw new DOMException("Aborted", "AbortError");
      }),
    };

    const sandbox = makeMockSandbox();

    const executor = new SandboxStepExecutor({
      sandboxSupplier: async () => sandbox,
      agentSupplier: () => fakeAgent as never,
    });

    const result = await executor.execute(
      makeStepExecution(),
      new AbortController().signal,
    );

    expect(result.error).toBeDefined();
    expect(result.error!.failureClass).toBe("cancellation");
    expect(result.error!.retryable).toBe(true);
    expect(sandbox.stop).toHaveBeenCalled();
  });

  it("builds checkpoint hints from step output", async () => {
    const fakeAgent = {
      run: mock(async () => ({
        text: "completed task",
        usage: { totalTokens: 10, inputTokens: 6, outputTokens: 4 },
        steps: 3,
      })),
    } as unknown as never;

    const executor = new SandboxStepExecutor({
      sandboxSupplier: async () => makeMockSandbox(),
      agentSupplier: () => fakeAgent as never,
    });

    const result = await executor.execute(
      makeStepExecution(),
      new AbortController().signal,
    );

    expect(result.checkpoints).toBeDefined();
    const checkpoints = result.checkpoints!;
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.stepId).toBeDefined();
  });

  it("runs without a sandbox (no sandboxSupplier) as pure model task", async () => {
    const fakeAgent: FakeAgent = {
      run: mock(async (_prompt: string, _options: { sandbox: unknown }) => ({
        text: "no sandbox output",
        usage: { totalTokens: 3, inputTokens: 2, outputTokens: 1 },
        steps: 1,
      })),
    };

    const executor = new SandboxStepExecutor({
      agentSupplier: () => fakeAgent as never,
    });

    const result = await executor.execute(
      makeStepExecution(),
      new AbortController().signal,
    );

    expect(result.error).toBeUndefined();
    expect((result.output as { text: string }).text).toBe("no sandbox output");
    expect(fakeAgent.run).toHaveBeenCalled();
  });

  it("always stops the sandbox even on agent failure", async () => {
    const sandbox = makeMockSandbox();
    const fakeAgent: FakeAgent = {
      run: mock(async () => {
        throw new Error("model crashed");
      }),
    };

    const executor = new SandboxStepExecutor({
      sandboxSupplier: async () => sandbox,
      agentSupplier: () => fakeAgent as never,
    });

    const result = await executor.execute(
      makeStepExecution(),
      new AbortController().signal,
    );

    expect(result.error).toBeDefined();
    expect(sandbox.stop).toHaveBeenCalled();
  });

  it("builds prompt from step and task spec", async () => {
    const fakeAgent: FakeAgent = {
      run: mock(async (prompt: string) => {
        expect(prompt).toContain("Task: fix the bug");
        expect(prompt).toContain("Instructions:");
        expect(prompt).toContain("check src/index.ts");
        expect(prompt).toContain("Attempt: 1");
        return { text: "ok", usage: {}, steps: 1 };
      }),
    };

    const executor = new SandboxStepExecutor({
      sandboxSupplier: async () => makeMockSandbox(),
      agentSupplier: () => fakeAgent as never,
    });

    await executor.execute(makeStepExecution(), new AbortController().signal);

    expect(fakeAgent.run).toHaveBeenCalledTimes(1);
  });
});
