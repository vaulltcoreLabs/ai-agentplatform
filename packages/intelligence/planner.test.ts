/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "bun:test";
import {
  createSpecialistRegistry,
  type SpecialistSpec,
  type Capability,
} from "./specialists";
import { DefaultPlanner } from "./planner";
import { DEFAULT_EXECUTION_POLICY } from "./policy";
import { createJobId } from "./ids";

function makeCtx(objective: string, missing?: string) {
  const registry = createSpecialistRegistry();
  if (missing) {
    const filtered = new Map(registry.specialists);
    filtered.delete(missing);
    // rebuild registry with only remaining
    const reg = {
      get: (role: string) =>
        (filtered.get(role) as SpecialistSpec | undefined) ?? undefined,
      select: (_req: readonly Capability[], _risk?: any) => undefined,
      query: (_req: readonly Capability[]) => [...filtered.values()],
      specialists: filtered,
    };
    const jobId = createJobId("test-tenant", objective);
    return {
      ctx: {
        objective,
        repository: undefined,
        constraints: {},
        capabilities: [],
        policy: DEFAULT_EXECUTION_POLICY,
        tenantId: "test-tenant",
        jobId,
        contextPath: () => [],
      },
      reg,
    };
  }
  const jobId = createJobId("test-tenant", objective);
  return {
    ctx: {
      objective,
      repository: undefined,
      constraints: {},
      capabilities: [],
      policy: DEFAULT_EXECUTION_POLICY,
      tenantId: "test-tenant",
      jobId,
      contextPath: () => [],
    },
    reg: registry,
  };
}

describe("planner", () => {
  it("produces a plan with explore, plan, verify", async () => {
    const { ctx, reg } = makeCtx("Add a new API endpoint");
    const planner = new DefaultPlanner();
    const result = await planner.plan(ctx, reg);
    expect(result.plan.taskIds.length).toBeGreaterThanOrEqual(3);
    expect(result.plan.tasks[0]!.specialist).toBe("explorer");
    expect(result.plan.tasks.some((t) => t.specialist === "verifier")).toBe(
      true,
    );
  });

  it("produces deterministic plan for same objective", async () => {
    const { ctx, reg } = makeCtx("Refactor auth module");
    const planner = new DefaultPlanner();
    const r1 = await planner.plan(ctx, reg);
    const r2 = await planner.plan(ctx, reg);
    expect(r1.plan.order).toEqual(r2.plan.order);
    expect(r1.plan.taskIds).toEqual(r2.plan.taskIds);
  });

  it("reports missing specialists", async () => {
    const { ctx, reg } = makeCtx("Task with missing explorer", "explorer");
    const planner = new DefaultPlanner();
    const result = await planner.plan(ctx, reg);
    expect(result.missing).toContain("explorer");
    expect(result.confidence).toBe(0.3);
  });

  it("respects policy constraints", async () => {
    const { ctx, reg } = makeCtx("Build feature");
    const planner = new DefaultPlanner();
    const result = await planner.plan(ctx, reg);
    const order = result.plan.order;
    // Every task's dependencies appear before it in the order.
    for (const task of result.plan.tasks) {
      for (const dep of task.dependsOn) {
        expect(order.indexOf(dep)).toBeLessThan(order.indexOf(task.id));
      }
    }
  });

  it("includes coder when available", async () => {
    const { ctx, reg } = makeCtx("Implement feature");
    const planner = new DefaultPlanner();
    const result = await planner.plan(ctx, reg);
    expect(result.plan.tasks.some((t) => t.specialist === "coder")).toBe(true);
  });

  it("includes tester and reviewer in chain", async () => {
    const { ctx, reg } = makeCtx("Implement feature");
    const planner = new DefaultPlanner();
    const result = await planner.plan(ctx, reg);
    expect(result.plan.tasks.some((t) => t.specialist === "tester")).toBe(true);
    expect(result.plan.tasks.some((t) => t.specialist === "reviewer")).toBe(
      true,
    );
  });

  it("full pipeline: verify depends on review", async () => {
    const { ctx, reg } = makeCtx("Implement feature");
    const planner = new DefaultPlanner();
    const result = await planner.plan(ctx, reg);
    const verifyTask = result.plan.tasks.find(
      (t) => t.specialist === "verifier",
    )!;
    expect(verifyTask).toBeDefined();
    // verify depends on review (which depends on test, which depends on coder)
    const reviewerTask = result.plan.tasks.find(
      (t) => t.specialist === "reviewer",
    )!;
    expect(verifyTask.dependsOn).toContain(reviewerTask.id);
  });

  it("full pipeline order is topologically valid", async () => {
    const { ctx, reg } = makeCtx("Implement feature");
    const planner = new DefaultPlanner();
    const result = await planner.plan(ctx, reg);
    const order = result.plan.order;
    for (const task of result.plan.tasks) {
      for (const dep of task.dependsOn) {
        expect(order.indexOf(dep)).toBeLessThan(order.indexOf(task.id));
      }
    }
  });
});
