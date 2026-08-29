import { describe, expect, it } from "bun:test";
import {
  createDurableJobId,
  createDurableRunId,
  createDurableTaskId,
  createDurableStepId,
  idemKey,
  createWorkerId,
  createLeaseId,
  durableId,
  jobNamespace,
} from "./identity";

describe("identity — deterministic ids", () => {
  const tenant = "tenant_abc";

  it("same inputs produce same job id", () => {
    const a = createDurableJobId(tenant, "build a web server");
    const b = createDurableJobId(tenant, "build a web server");
    expect(a).toBe(b);
  });

  it("different objectives produce different job ids", () => {
    const a = createDurableJobId(tenant, "build a web server");
    const b = createDurableJobId(tenant, "refactor auth");
    expect(a).not.toBe(b);
  });

  it("same tenant + objective produces disjoint ids across tenants", () => {
    const a = createDurableJobId("tenant_a", "build a web server");
    const b = createDurableJobId("tenant_b", "build a web server");
    expect(a).not.toBe(b);
  });

  it("run id is deterministic on job + version", () => {
    const jobId = createDurableJobId(tenant, "build a web");
    const r1 = createDurableRunId(jobId, 1);
    const r2 = createDurableRunId(jobId, 1);
    const r3 = createDurableRunId(jobId, 2);
    expect(r1).toBe(r2);
    expect(r1).not.toBe(r3);
  });

  it("task id is deterministic on job + descriptor", () => {
    const jobId = createDurableJobId(tenant, "build a web");
    const t1 = createDurableTaskId(jobId, "coder:main");
    const t2 = createDurableTaskId(jobId, "coder:main");
    expect(t1).toBe(t2);
  });

  it("step id is deterministic on task + attempt", () => {
    const jobId = createDurableJobId(tenant, "build a web");
    const taskId = createDurableTaskId(jobId, "coder:main");
    const s1 = createDurableStepId(taskId, 1);
    const s2 = createDurableStepId(taskId, 1);
    const s3 = createDurableStepId(taskId, 2);
    expect(s1).toBe(s2);
    expect(s1).not.toBe(s3);
  });

  it("durable ids use djob/drun/dtask/dstep prefixes", () => {
    const jobId = createDurableJobId(tenant, "build");
    const runId = createDurableRunId(jobId, 1);
    const taskId = createDurableTaskId(jobId, "main");
    const stepId = createDurableStepId(taskId, 1);
    expect(jobId.startsWith("djob_")).toBe(true);
    expect(runId.startsWith("drun_")).toBe(true);
    expect(taskId.startsWith("dtask_")).toBe(true);
    expect(stepId.startsWith("dstep_")).toBe(true);
  });

  it("durableId hashes deterministically", () => {
    const ns = jobNamespace(tenant);
    const a = durableId(ns, "part1", "part2");
    const b = durableId({ prefix: "djob", salt: tenant }, "part1", "part2");
    expect(a).toBe(b);
  });
});

describe("identity — idempotency keys", () => {
  it("same inputs produce same key", () => {
    const a = idemKey("t1", "resource1", "submit");
    const b = idemKey("t1", "resource1", "submit");
    expect(a).toBe(b);
  });

  it("different operations produce different keys", () => {
    const a = idemKey("t1", "resource1", "submit");
    const b = idemKey("t1", "resource1", "cancel");
    expect(a).not.toBe(b);
  });

  it("keys have idem_ prefix", () => {
    expect(idemKey("t1", "r1", "op").startsWith("idem_")).toBe(true);
  });
});

describe("identity — worker & lease ids", () => {
  it("worker id is tenant-scoped and non-empty", () => {
    const w = createWorkerId("tenant_abc");
    expect(w.startsWith("tenant_abc".substring(0, 8))).toBe(true);
    expect(w).toContain("worker");
  });

  it("lease id is non-empty", () => {
    const l = createLeaseId();
    expect(l.length).toBeGreaterThan(0);
  });

  it("two lease ids are different", () => {
    const a = createLeaseId();
    const b = createLeaseId();
    expect(a).not.toBe(b);
  });
});
