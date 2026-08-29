import { describe, expect, it } from "bun:test";
import {
  initialBudget,
  checkBudget,
  isDeadlineExceeded,
  childDeadline,
  computeRunDeadline,
} from "./deadlines";
import type { RunBudget } from "./model";

const BUDGET: RunBudget = {
  maxRuntimeMs: 60_000,
  maxModelCalls: 10,
  maxToolCalls: 20,
  maxInputTokens: 100_000,
  maxOutputTokens: 50_000,
};

describe("deadlines — budget check", () => {
  it("returns undefined when within budget", () => {
    const state = initialBudget(1000);
    state.modelCalls = 5;
    state.toolCalls = 10;
    state.inputTokens = 50_000;
    state.outputTokens = 25_000;
    expect(checkBudget(state, BUDGET, 1000)).toBeUndefined();
  });

  it("detects runtime breach", () => {
    const state = initialBudget(1000);
    state.modelCalls = 1;
    state.toolCalls = 1;
    state.inputTokens = 1;
    state.outputTokens = 1;
    const breach = checkBudget(state, BUDGET, 70_000);
    expect(breach).toBeDefined();
    expect(breach!.kind).toBe("runtime");
    expect(breach!.observed).toBe(69_000);
  });

  it("detects model call breach", () => {
    const state = initialBudget(1000);
    state.modelCalls = 11;
    const breach = checkBudget(state, BUDGET, 2000);
    expect(breach!.kind).toBe("model_calls");
  });

  it("detects tool call breach", () => {
    const state = initialBudget(1000);
    state.toolCalls = 21;
    const breach = checkBudget(state, BUDGET, 2000);
    expect(breach!.kind).toBe("tool_calls");
  });

  it("detects input token breach", () => {
    const state = initialBudget(1000);
    state.inputTokens = 100_001;
    const breach = checkBudget(state, BUDGET, 2000);
    expect(breach!.kind).toBe("input_tokens");
  });

  it("detects output token breach", () => {
    const state = initialBudget(1000);
    state.outputTokens = 50_001;
    const breach = checkBudget(state, BUDGET, 2000);
    expect(breach!.kind).toBe("output_tokens");
  });

  it("does not flag at exact limit", () => {
    const state = initialBudget(1000);
    state.modelCalls = 10;
    state.toolCalls = 20;
    state.inputTokens = 100_000;
    state.outputTokens = 50_000;
    expect(checkBudget(state, BUDGET, 2000)).toBeUndefined();
  });
});

describe("deadlines — deadline helpers", () => {
  it("isDeadlineExceeded returns false for future deadline", () => {
    expect(isDeadlineExceeded(5000, 1000)).toBe(false);
  });

  it("isDeadlineExceeded returns true for past deadline", () => {
    expect(isDeadlineExceeded(500, 1000)).toBe(true);
  });

  it("isDeadlineExceeded returns false for undefined", () => {
    expect(isDeadlineExceeded(undefined, 1000)).toBe(false);
  });
});

describe("deadlines — childDeadline", () => {
  it("returns own deadline when parent is far", () => {
    expect(childDeadline(100_000, 5_000, 1000)).toBe(6000);
  });

  it("clamps to parent deadline", () => {
    expect(childDeadline(5_000, 10_000, 1000)).toBe(5000);
  });

  it("returns undefined when parent already expired", () => {
    expect(childDeadline(500, 10_000, 1000)).toBeUndefined();
  });

  it("returns finite deadline when no parent", () => {
    expect(childDeadline(undefined, 5_000, 1000)).toBe(6000);
  });
});

describe("deadlines — computeRunDeadline", () => {
  it("adds max runtime to start", () => {
    expect(computeRunDeadline(BUDGET, 1000)).toBe(61_000);
  });
});

describe("deadlines — BudgetState", () => {
  it("initialBudget has zeroed counters", () => {
    const state = initialBudget(1000);
    expect(state.startedAt).toBe(1000);
    expect(state.modelCalls).toBe(0);
    expect(state.toolCalls).toBe(0);
    expect(state.inputTokens).toBe(0);
    expect(state.outputTokens).toBe(0);
  });
});
