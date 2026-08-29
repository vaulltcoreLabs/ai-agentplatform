import { describe, expect, it } from "bun:test";
import {
  scheduleExecution,
  type SchedulerCallbacks,
  type SchedulerDeps,
} from "./scheduler";
import { JobAggregate } from "./job-model";
import { buildTaskGraph } from "./task-graph";
import { BudgetTracker } from "./budget";
import { DEFAULT_EXECUTION_POLICY } from "./policy";

function makeJob(objective = "test") {
  return new JobAggregate({
    id: "job-scheduler-test",
    tenantId: "tenant-1",
    objective,
    policy: DEFAULT_EXECUTION_POLICY,
    budget: {
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      runtimeMs: 0,
      activeAgents: 0,
    },
  });
}

function makeGraph(tasks: { id: string; dependsOn?: string[] }[]) {
  return buildTaskGraph(
    tasks.map((t) => ({
      id: t.id,
      name: t.id,
      specialist: "explorer",
      dependsOn: t.dependsOn ?? [],
      input: {},
    })),
  );
}

describe("scheduler", () => {
  it("runs all tasks in dependency order", async () => {
    const job = makeJob();
    const graph = makeGraph([
      { id: "a" },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ]);
    job.setPlan({
      taskIds: graph.order,
      order: graph.order,
      tasks: graph.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        specialist: n.specialist,
        dependsOn: [...n.dependsOn],
        input: n.input,
      })),
    });

    const completed: string[] = [];
    const deps: SchedulerDeps = {
      policy: { ...DEFAULT_EXECUTION_POLICY, maxParallelism: 2 },
      budget: new BudgetTracker({
        ...DEFAULT_EXECUTION_POLICY,
        maxParallelism: 2,
      }),
      log: { warn: () => {}, error: () => {} },
    };
    const cb: SchedulerCallbacks = {
      runTask: async (scheduled) => {
        completed.push(scheduled.task.spec.id);
        return { done: true };
      },
      onCompleted: async () => {},
      onFailed: async () => {},
    };

    const result = await scheduleExecution(
      deps,
      job,
      graph,
      cb,
      new AbortController().signal,
    );
    expect(result.completed).toEqual(["a", "b", "c"]);
    expect(result.failed).toEqual([]);
    expect(completed).toEqual(["a", "b", "c"]);
  });

  it("propagates failures to dependents", async () => {
    const job = makeJob();
    const graph = makeGraph([
      { id: "a" },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ]);
    job.setPlan({
      taskIds: graph.order,
      order: graph.order,
      tasks: graph.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        specialist: n.specialist,
        dependsOn: [...n.dependsOn],
        input: n.input,
      })),
    });

    const deps: SchedulerDeps = {
      policy: DEFAULT_EXECUTION_POLICY,
      budget: new BudgetTracker(DEFAULT_EXECUTION_POLICY),
      log: { warn: () => {}, error: () => {} },
    };
    const cb: SchedulerCallbacks = {
      runTask: async (scheduled) => {
        if (scheduled.task.spec.id === "a") {
          throw new Error("task a failed");
        }
        return { done: true };
      },
      onCompleted: async () => {},
      onFailed: async () => {},
    };

    const result = await scheduleExecution(
      deps,
      job,
      graph,
      cb,
      new AbortController().signal,
    );
    expect(result.failed).toContain("a");
    expect(result.skipped).toContain("b");
    expect(result.skipped).toContain("c");
  });

  it("respects maxParallelism", async () => {
    const job = makeJob();
    const graph = makeGraph([{ id: "a" }, { id: "b" }, { id: "c" }]);
    job.setPlan({
      taskIds: graph.order,
      order: graph.order,
      tasks: graph.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        specialist: n.specialist,
        dependsOn: [...n.dependsOn],
        input: n.input,
      })),
    });

    let concurrent = 0;
    let maxSeen = 0;
    const deps: SchedulerDeps = {
      policy: { ...DEFAULT_EXECUTION_POLICY, maxParallelism: 2 },
      budget: new BudgetTracker({ ...DEFAULT_EXECUTION_POLICY, maxAgents: 2 }),
      log: { warn: () => {}, error: () => {} },
    };
    const cb: SchedulerCallbacks = {
      runTask: async () => {
        concurrent++;
        maxSeen = Math.max(maxSeen, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent--;
        return {};
      },
      onCompleted: async () => {},
      onFailed: async () => {},
    };

    await scheduleExecution(deps, job, graph, cb, new AbortController().signal);
    expect(maxSeen).toBeLessThanOrEqual(2);
  });

  it("aborts on signal", async () => {
    const job = makeJob();
    const graph = makeGraph([{ id: "a" }, { id: "b" }]);
    job.setPlan({
      taskIds: graph.order,
      order: graph.order,
      tasks: graph.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        specialist: n.specialist,
        dependsOn: [...n.dependsOn],
        input: n.input,
      })),
    });

    const controller = new AbortController();
    const deps: SchedulerDeps = {
      policy: DEFAULT_EXECUTION_POLICY,
      budget: new BudgetTracker(DEFAULT_EXECUTION_POLICY),
      log: { warn: () => {}, error: () => {} },
    };
    const cb: SchedulerCallbacks = {
      runTask: async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {};
      },
      onCompleted: async () => {},
      onFailed: async () => {},
    };

    const result = await scheduleExecution(
      deps,
      job,
      graph,
      cb,
      controller.signal,
    );
    expect(result.error).toBeDefined();
  });

  it("rejects cyclic graphs", async () => {
    const job = makeJob();
    const specs = [
      {
        id: "a",
        name: "a",
        specialist: "explorer",
        dependsOn: ["c"],
        input: {},
      },
      {
        id: "b",
        name: "b",
        specialist: "explorer",
        dependsOn: ["a"],
        input: {},
      },
      {
        id: "c",
        name: "c",
        specialist: "explorer",
        dependsOn: ["b"],
        input: {},
      },
    ];
    const graph = buildTaskGraph(specs);
    const deps: SchedulerDeps = {
      policy: DEFAULT_EXECUTION_POLICY,
      budget: new BudgetTracker(DEFAULT_EXECUTION_POLICY),
      log: { warn: () => {}, error: () => {} },
    };
    const cb: SchedulerCallbacks = {
      runTask: async () => ({}),
      onCompleted: async () => {},
      onFailed: async () => {},
    };

    const result = await scheduleExecution(
      deps,
      job,
      graph,
      cb,
      new AbortController().signal,
    );
    expect(result.error).toBeDefined();
  });
});
