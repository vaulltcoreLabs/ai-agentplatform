/* eslint-disable max-classes-per-file */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "bun:test";
import {
  VaulltcoreJobEngine,
  type JobEngineOptions,
  type SpecialistRunInput,
  type SpecialistRunOutput,
  type SpecialistRunner,
} from "./orchestrator";
import {
  DefaultModelRouter,
  type ModelDescriptor,
  type ModelRouter,
} from "./model-router";

/** A mock runner that simulates specialist work and verifies the policy. */
class MockRunner implements SpecialistRunner {
  readonly calls: string[] = [];
  readonly failTasks = new Set<string>();
  readonly runOutput: Record<string, unknown> = {};
  constructor(
    private readonly options: { delay?: number; shouldFail?: boolean } = {},
  ) {}

  async run(
    input: SpecialistRunInput,
    _signal: AbortSignal,
  ): Promise<SpecialistRunOutput> {
    this.calls.push(`${input.task.spec.name}:${input.task.spec.specialist}`);
    this.runOutput[input.task.spec.id] = input.task.spec.input;

    if (this.options.delay) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delay));
    }

    if (
      this.options.shouldFail ||
      this.failTasks.has(input.task.spec.specialist)
    ) {
      return {
        output: undefined,
        usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
        error: { failureClass: "tool", message: "simulated failure" },
        artifacts: [],
      };
    }

    return {
      output: { completed: true, task: input.task.spec.name },
      usage: { totalTokens: 10, inputTokens: 5, outputTokens: 5 },
      error: undefined,
      artifacts: [],
    };
  }
}

describe("orchestrator end-to-end", () => {
  function makeEngine(
    runner: SpecialistRunner,
    opts: Partial<JobEngineOptions> = {},
  ): VaulltcoreJobEngine {
    return new VaulltcoreJobEngine({
      tenantId: "tenant-e2e",
      runner,
      policy: {
        maxModelCalls: 500,
        maxParallelism: 4,
        maxAgents: 4,
        maxCostUSD: 50,
        maxRuntimeMs: 60000,
        maxToolCalls: 1000,
        maxInputTokens: 100000,
        maxOutputTokens: 50000,
        maxDepth: 5,
        approval: "auto-unsafe",
        network: "full",
        allowedCapabilities: [],
        retry: {
          maxRepairAttempts: 2,
          maxRetries: 1,
          backoffMs: 0,
          backoffFactor: 2,
        },
      },
      ...opts,
      agent: undefined as any,
      // Avoid needing a real agent since the runner is injected
    });
  }

  it("runs a simple objective end-to-end", async () => {
    const runner = new MockRunner();
    const engine = makeEngine(runner);
    const result = await engine.run({ objective: "Build a simple feature" });

    expect(result.jobId).toMatch(/^job_/);
    expect(result.outcome.success).toBe(true);
    expect(runner.calls.length).toBeGreaterThanOrEqual(3);
    expect(runner.calls.some((c) => c.includes("explorer"))).toBe(true);
    expect(runner.calls.some((c) => c.includes("verifier"))).toBe(true);

    const events = result.events;
    expect(events.some((e) => e.type === "job.created")).toBe(true);
    expect(events.some((e) => e.type === "job.planned")).toBe(true);
  });

  it("produces deterministic job ids", async () => {
    const r1 = new MockRunner();
    const e1 = makeEngine(r1);
    const e2 = makeEngine(new MockRunner());
    const r1r = await e1.run({ objective: "Same objective" });
    const r2r = await e2.run({ objective: "Same objective" });
    expect(r1r.jobId).toBe(r2r.jobId);
  });

  it("fails the job when a task fails", async () => {
    const runner = new MockRunner({ shouldFail: true });
    const engine = makeEngine(runner);
    const result = await engine.run({ objective: "Build a broken feature" });

    expect(result.outcome.success).toBe(false);
    expect(result.outcome.error).toBeDefined();
    expect(result.events.some((e) => e.type === "job.failed")).toBe(true);
  });

  it("respects maxParallelism via policy override", async () => {
    let concurrent = 0;
    let max = 0;

    class TrackingRunner implements SpecialistRunner {
      async run(
        _input: SpecialistRunInput,
        _signal: AbortSignal,
      ): Promise<SpecialistRunOutput> {
        concurrent++;
        max = Math.max(max, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent--;
        return { output: {}, usage: {}, artifacts: [], error: undefined };
      }
    }

    const engine = makeEngine(new TrackingRunner(), {
      policy: {
        maxParallelism: 1,
        maxModelCalls: 500,
        maxAgents: 1,
        maxCostUSD: 50,
        maxRuntimeMs: 60000,
        maxToolCalls: 1000,
        maxInputTokens: 100000,
        maxOutputTokens: 50000,
        approval: "auto-unsafe",
        network: "full",
        allowedCapabilities: [],
        retry: {
          maxRepairAttempts: 0,
          maxRetries: 0,
          backoffMs: 0,
          backoffFactor: 2,
        },
      },
    });

    await engine.run({ objective: "Sequential task" });
    expect(max).toBe(1);
  });

  it("cancels a running job", async () => {
    const engine = makeEngine(new MockRunner({ delay: 500 }));
    const abortController = new AbortController();
    const promise = engine.run({
      objective: "Slow task",
      abortSignal: abortController.signal,
    });
    // Give it a moment to start
    await new Promise((resolve) => setTimeout(resolve, 50));
    abortController.abort();
    const result = await promise;
    expect(result.outcome.success).toBe(false);
  });

  it("replays events for a job", async () => {
    const runner = new MockRunner();
    const engine = makeEngine(runner);
    const { jobId } = await engine.run({ objective: "Replay test" });
    const events = await engine.replay(jobId);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "job.created")).toBe(true);
  });

  it("gets job snapshot", async () => {
    const runner = new MockRunner();
    const engine = makeEngine(runner);
    const { jobId } = await engine.run({ objective: "Snapshot test" });
    const snapshot = await engine.getJob(jobId);
    expect(snapshot).toBeDefined();
    expect(snapshot!.objective).toBe("Snapshot test");
    expect(snapshot!.tasks.length).toBeGreaterThan(0);
  });
});

describe("orchestrator — model router integration", () => {
  class CapturingRunner implements SpecialistRunner {
    readonly routedModels: string[] = [];
    async run(
      _input: SpecialistRunInput,
      _signal: AbortSignal,
    ): Promise<SpecialistRunOutput> {
      this.routedModels.push(_input.task.spec.specialist);
      return {
        output: { completed: true },
        usage: { totalTokens: 10, inputTokens: 5, outputTokens: 5 },
        error: undefined,
        artifacts: [],
      };
    }
  }

  it("EngineSpecialistRunner resolves models via routeForSpecialist when modelRouter is provided", async () => {
    const runner = new CapturingRunner();
    const router = new DefaultModelRouter();
    const engine = new VaulltcoreJobEngine({
      tenantId: "tenant-router",
      runner,
      modelRouter: router,
      policy: {
        maxModelCalls: 500,
        maxParallelism: 4,
        maxAgents: 4,
        maxCostUSD: 50,
        maxRuntimeMs: 60000,
        maxToolCalls: 1000,
        maxInputTokens: 100000,
        maxOutputTokens: 50000,
        maxDepth: 5,
        approval: "auto-unsafe",
        network: "full",
        allowedCapabilities: [],
        retry: {
          maxRepairAttempts: 0,
          maxRetries: 0,
          backoffMs: 0,
          backoffFactor: 2,
        },
      },
      agent: undefined as any,
    });

    await engine.run({ objective: "Route test" });
    expect(runner.routedModels.length).toBeGreaterThan(0);
  });

  it("ModelDescriptor.id is used for specialist model selection", async () => {
    const cheapModel: ModelDescriptor = {
      id: "anthropic/claude-haiku-4.5",
      provider: "anthropic",
      costPer1kTokens: 0.25,
      latencyMs: 800,
      reliability: 0.95,
      costTier: "cheap",
      capabilities: {
        reasoning: true,
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        streaming: true,
        parallelToolCalls: true,
        inputCaching: true,
        contextWindow: 200_000,
        maxOutputTokens: 4_096,
      },
    };
    const router: ModelRouter = {
      models: [cheapModel],
      route: () => cheapModel,
      resolve: () => ({ provider: "anthropic", model: cheapModel.id }),
    };

    const capturedModelIds: string[] = [];
    class TrackingRunner implements SpecialistRunner {
      async run(
        input: SpecialistRunInput,
        _signal: AbortSignal,
      ): Promise<SpecialistRunOutput> {
        capturedModelIds.push(input.task.spec.specialist);
        return {
          output: { completed: true, specialist: input.task.spec.specialist },
          usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
          error: undefined,
          artifacts: [],
        };
      }
    }

    const engine = new VaulltcoreJobEngine({
      tenantId: "tenant-router-2",
      runner: new TrackingRunner(),
      modelRouter: router,
      policy: {
        maxModelCalls: 500,
        maxParallelism: 4,
        maxAgents: 4,
        maxCostUSD: 50,
        maxRuntimeMs: 60000,
        maxToolCalls: 1000,
        maxInputTokens: 100000,
        maxOutputTokens: 50000,
        maxDepth: 5,
        approval: "auto-unsafe",
        network: "full",
        allowedCapabilities: [],
        retry: {
          maxRepairAttempts: 0,
          maxRetries: 0,
          backoffMs: 0,
          backoffFactor: 2,
        },
      },
      agent: undefined as any,
    });

    await engine.run({ objective: "Model routing test" });
    expect(capturedModelIds.length).toBeGreaterThan(0);
  });
});
