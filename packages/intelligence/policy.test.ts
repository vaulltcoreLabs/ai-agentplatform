import { describe, expect, it } from "bun:test";
import {
  DEFAULT_EXECUTION_POLICY,
  applyPolicyOverride,
  type PolicyOverride,
} from "./policy";

describe("policy", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_EXECUTION_POLICY.maxAgents).toBe(32);
    expect(DEFAULT_EXECUTION_POLICY.maxModelCalls).toBe(1000);
    expect(DEFAULT_EXECUTION_POLICY.approval).toBe("auto-unsafe");
  });

  it("applies overrides", () => {
    const override: PolicyOverride = {
      maxAgents: 2,
      maxModelCalls: 10,
      approval: "manual-required",
    };
    const p = applyPolicyOverride(DEFAULT_EXECUTION_POLICY, override);
    expect(p.maxAgents).toBe(2);
    expect(p.maxModelCalls).toBe(10);
    expect(p.approval).toBe("manual-required");
  });

  it("merges without losing unmodified fields", () => {
    const p = applyPolicyOverride(DEFAULT_EXECUTION_POLICY, { maxCostUSD: 5 });
    expect(p.maxCostUSD).toBe(5);
    expect(p.maxAgents).toBe(DEFAULT_EXECUTION_POLICY.maxAgents);
  });

  it("clamps maxAgents to at least 1", () => {
    const p = applyPolicyOverride(DEFAULT_EXECUTION_POLICY, { maxAgents: 0 });
    expect(p.maxAgents).toBe(1);
  });
});
