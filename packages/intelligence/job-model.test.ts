/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "bun:test";
import { JobAggregate } from "./job-model";
import { DEFAULT_EXECUTION_POLICY } from "./policy";

const baseParams = {
  id: "test-job-id",
  tenantId: "tenant-1",
  objective: "Add a new feature",
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
} as const;

function makePlanJob() {
  const job = new JobAggregate(baseParams);
  job.setPlan({
    taskIds: ["a", "b"],
    order: ["a", "b"],
    tasks: [
      { id: "a", name: "A", specialist: "explorer", dependsOn: [], input: {} },
      { id: "b", name: "B", specialist: "coder", dependsOn: ["a"], input: {} },
    ],
  });
  return job;
}

describe("job-model", () => {
  it("starts in pending status", () => {
    const job = new JobAggregate(baseParams);
    expect(job.status).toBe("pending");
  });

  it("transitions through lifecycle", () => {
    const job = new JobAggregate(baseParams);
    job.setStatus("planning");
    expect(job.status).toBe("planning");
    job.setStatus("running");
    expect(job.status).toBe("running");
    job.complete(true, "done");
    expect(job.status).toBe("completed");
    expect(job.outcome).toBeDefined();
    expect(job.outcome!.success).toBe(true);
  });

  it("records tasks on plan", () => {
    const job = makePlanJob();
    expect(job.tasks.length).toBe(2);
    expect(job.getTask("a")).toBeDefined();
    expect(job.getTask("b")).toBeDefined();
  });

  it("sets task status with valid transitions", () => {
    const job = makePlanJob();
    job.setTaskStatus("a", "ready");
    expect(job.getTask("a")!.status).toBe("ready");
    job.setTaskStatus("a", "running");
    expect(job.getTask("a")!.status).toBe("running");
    job.setTaskStatus("a", "completed");
    expect(job.getTask("a")!.status).toBe("completed");
  });

  it("setTaskResult stores output and result", () => {
    const job = makePlanJob();
    job.setTaskStatus("a", "ready");
    job.setTaskStatus("a", "running");
    job.setTaskResult("a", { result: "ok" }, { totalTokens: 10 });
    const task = job.getTask("a")!;
    expect(task.output).toEqual({ result: "ok" });
    expect(task.result?.usage?.totalTokens).toBe(10);
  });

  it("fails a job", () => {
    const job = new JobAggregate(baseParams);
    job.fail("verification", "tests failed");
    expect(job.status).toBe("failed");
    expect(job.outcome!.success).toBe(false);
    expect(job.outcome!.error).toBe("tests failed");
  });

  it("cancels a job", () => {
    const job = new JobAggregate(baseParams);
    job.cancel("user abort");
    expect(job.status).toBe("cancelled");
    expect(job.outcome!.success).toBe(false);
  });

  it("records task attempts", () => {
    const job = makePlanJob();
    job.recordAttempt("a", {
      attempt: 1,
      startedAt: Date.now(),
      endedAt: Date.now(),
      error: { failureClass: "tool", message: "timeout" },
    });
    expect(job.getTask("a")!.attempts.length).toBe(1);
  });

  it("tracks budget", () => {
    const job = new JobAggregate(baseParams);
    job.consumeBudget({
      modelCalls: 5,
      toolCalls: 2,
      inputTokens: 10,
      outputTokens: 3,
      costUSD: 0.01,
      runtimeMs: 100,
      activeAgents: 0,
    });
    const snapshot = job.snapshot().budget;
    expect(snapshot.modelCalls).toBe(5);
    expect(snapshot.toolCalls).toBe(2);
  });

  it("snapshot is a defensive copy", () => {
    const job = new JobAggregate(baseParams);
    const s1 = job.snapshot();
    const s2 = job.snapshot();
    expect(s1).not.toBe(s2);
    expect(s1).toEqual(s2);
  });

  it("setTaskStatus throws on unknown task", () => {
    const job = makePlanJob();
    expect(() => job.setTaskStatus("nope", "running")).toThrow();
  });

  it("completed job cannot transition to cancelled", () => {
    const job = new JobAggregate(baseParams);
    job.setStatus("planning");
    job.setStatus("running");
    job.complete(true, "done");
    expect(() => job.setStatus("cancelled" as any)).toThrow();
  });

  it("task states are terminal when completed", () => {
    const job = makePlanJob();
    job.setTaskStatus("a", "ready");
    job.setTaskStatus("a", "running");
    expect(job.getTask("a")?.status).toBe("running");
    job.setTaskStatus("a", "completed");
    expect(job.getTask("a")?.status).toBe("completed");
  });

  it("fail with success=false", () => {
    const job = new JobAggregate(baseParams);
    job.fail("timeout", "timed out");
    expect(job.outcome!.success).toBe(false);
  });
});
