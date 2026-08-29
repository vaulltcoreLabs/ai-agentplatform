import { describe, expect, it } from "bun:test";
import {
  newCorrelation,
  withTask,
  verificationCorrelation,
  type CorrelationId,
} from "./correlation";
import { createJobId } from "./ids";

describe("correlation", () => {
  it("newCorrelation creates a valid bundle", () => {
    const jobId = createJobId("tenant-1", "objective");
    const c: CorrelationId = newCorrelation("tenant-1", jobId);
    expect(c.tenant).toBe("tenant-1");
    expect(c.job).toBe(jobId);
    expect(c.task).toBeUndefined();
    expect(c.agent).toBeUndefined();
    expect(c.sandbox).toBeDefined();
    expect(c.verification).toBeDefined();
  });

  it("withTask extends a correlation with a task id", () => {
    const jobId = createJobId("tenant-1", "objective");
    const base = newCorrelation("tenant-1", jobId);
    const child = withTask(base, "task-1");
    expect(child.task).toBe("task-1");
    expect(child.tenant).toBe("tenant-1");
    expect(child.job).toBe(jobId);
    expect(child.agent).toBeDefined();
  });

  it("withTask allows agent override", () => {
    const jobId = createJobId("t", "o");
    const base = newCorrelation("t", jobId);
    const child = withTask(base, "task-1", { agent: "agent-xyz" });
    expect(child.agent).toBe("agent-xyz");
    expect(child.task).toBe("task-1");
  });

  it("withTask preserves parent fields", () => {
    const jobId = createJobId("t", "o");
    const base = withTask(newCorrelation("t", jobId), "task-0");
    const child = withTask(base, "task-1");
    expect(child.sandbox).toBe(base.sandbox);
    expect(child.task).toBe("task-1");
  });

  it("verificationCorrelation regenerates verification id", () => {
    const jobId = createJobId("t", "o");
    const base = newCorrelation("t", jobId);
    const ver = verificationCorrelation(base);
    expect(ver.verification).not.toBe(base.verification);
    expect(ver.tenant).toBe("t");
    expect(ver.job).toBe(jobId);
  });
});
