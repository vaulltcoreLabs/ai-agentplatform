import { describe, expect, it } from "bun:test";
import {
  BudgetTracker,
  emptyBudget,
  cloneBudget,
  budgetExceeded,
} from "./budget";
import { DEFAULT_EXECUTION_POLICY } from "./policy";

describe("budget", () => {
  it("starts at zero", () => {
    const t = new BudgetTracker(DEFAULT_EXECUTION_POLICY);
    expect(t.consumed).toEqual(emptyBudget());
  });

  it("tracks model calls", () => {
    const t = new BudgetTracker({
      ...DEFAULT_EXECUTION_POLICY,
      maxModelCalls: 3,
    });
    expect(t.recordModelCall()).toBeUndefined();
    expect(t.recordModelCall()).toBeUndefined();
    expect(t.recordModelCall()).toBeUndefined();
    const breach = t.recordModelCall();
    expect(breach).toBeDefined();
    expect(breach!.kind).toBe("modelCalls");
    expect(breach!.consumed).toBe(4);
    expect(budgetExceeded(breach)).toBe(true);
  });

  it("acquires/releases agents", () => {
    const t = new BudgetTracker({ ...DEFAULT_EXECUTION_POLICY, maxAgents: 1 });
    expect(t.acquireAgent()).toBeUndefined();
    expect(t.acquireAgent()).toBeDefined(); // breach
    t.releaseAgent();
    expect(t.acquireAgent()).toBeUndefined();
  });

  it("records runtime", () => {
    const t = new BudgetTracker({
      ...DEFAULT_EXECUTION_POLICY,
      maxRuntimeMs: 100,
    });
    const breach = t.recordRuntime(101);
    expect(breach).toBeDefined();
    expect(breach!.kind).toBe("runtimeMs");
  });

  it("cloneBudget returns a copy", () => {
    const b = emptyBudget();
    b.modelCalls = 5;
    const c = cloneBudget(b);
    expect(c.modelCalls).toBe(5);
    c.modelCalls = 999;
    expect(b.modelCalls).toBe(5);
  });

  it("exhausted reflects hard ceilings", () => {
    const p = { ...DEFAULT_EXECUTION_POLICY, maxModelCalls: 1 };
    const t = new BudgetTracker(p);
    expect(t.exhausted).toBe(false);
    t.recordModelCall();
    expect(t.exhausted).toBe(false); // consumed 1, limit 1 (last allowed)
    t.recordModelCall();
    expect(t.exhausted).toBe(true); // consumed 2, limit 1
  });
});
