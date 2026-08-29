import { describe, expect, it } from "bun:test";
import {
  createJobId,
  createTaskId,
  deterministicId,
  jobIdNamespace,
  taskIdNamespace,
  taskInputSignature,
} from "./ids";

describe("ids", () => {
  it("creates deterministic job ids", () => {
    const a = createJobId("tenant-1", "deploy service");
    const b = createJobId("tenant-1", "deploy service");
    expect(a).toBe(b);
    expect(a).toMatch(/^job_/);
  });

  it("job id is namespaced and stable", () => {
    const id = createJobId("acme", "fix bug #42");
    expect(id).toMatch(/^job_/);
    expect(jobIdNamespace(id).prefix).toBe("job");
  });

  it("creates deterministic task ids", () => {
    const sig = taskInputSignature("coder", { task: "implement X" });
    const t1 = createTaskId(createJobId("acme", "objective"), sig);
    const t2 = createTaskId(createJobId("acme", "objective"), sig);
    expect(t1).toBe(t2);
    expect(t1).toMatch(/^task_/);
  });

  it("task id namespace differs from job id namespace", () => {
    const jobId = createJobId("acme", "obj");
    const sig = taskInputSignature("coder", { task: "do" });
    createTaskId(jobId, sig);
    expect(jobIdNamespace(jobId).prefix).toBe("job");
    expect(taskIdNamespace(jobId).prefix).toBe("task");
  });

  it("deterministicId hashes input consistently", () => {
    const ns = { prefix: "prefix", salt: "test-salt" };
    const h1 = deterministicId(ns, JSON.stringify({ foo: "bar", n: 1 }));
    const h2 = deterministicId(ns, JSON.stringify({ foo: "bar", n: 1 }));
    const h3 = deterministicId(ns, JSON.stringify({ foo: "bar", n: 2 }));
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^prefix_/);
  });
});
