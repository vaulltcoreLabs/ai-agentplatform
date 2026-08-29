/* eslint-disable @typescript-eslint/no-explicit-any, unicorn/prefer-module, node/global-require */
import { describe, expect, it } from "bun:test";
import {
  createSpecialistRegistry,
  DEFAULT_SPECIALISTS,
  SPECIALIST_TO_SUBAGENT,
  type SpecialistSpec,
  type Capability,
} from "./specialists";

describe("specialists", () => {
  it("has the default catalogue", () => {
    const registry = createSpecialistRegistry();
    expect(registry.get("explorer")).toBeDefined();
    expect(registry.get("coder")).toBeDefined();
    expect(registry.get("verifier")).toBeDefined();
  });

  it("selects by capability", () => {
    const registry = createSpecialistRegistry();
    const coder = registry.select(["write", "execute"], "high");
    expect(coder?.role).toBe("coder");
  });

  it("returns undefined when no specialist matches", () => {
    const registry = createSpecialistRegistry();
    const spec = registry.select(["nonexistent-capability" as Capability]);
    expect(spec).toBeUndefined();
  });

  it("respects risk ceiling", () => {
    const registry = createSpecialistRegistry();
    const lowOnly = registry.select(["review"], "low");
    // reviewer is medium risk, so low ceiling excludes it
    expect(lowOnly).toBeUndefined();
    const mid = registry.select(["review"], "medium");
    expect(mid?.role).toBe("reviewer");
    const high = registry.select(["review"], "high");
    expect(high?.role).toBe("reviewer");
  });

  it("query returns all matching sorted by risk", () => {
    const registry = createSpecialistRegistry();
    const matches = registry.query(["review"]);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // Lower risk rank first
    const ranks = matches.map((m) => m.risk);
    const rank = (x: string) => (x === "low" ? 0 : x === "medium" ? 1 : 2);
    const sortedRanks = [...ranks].sort((a, b) => rank(a) - rank(b));
    expect(ranks).toEqual(sortedRanks);
  });

  it("overrides replace defaults", () => {
    const custom: SpecialistSpec = {
      role: "coder",
      description: "custom coder",
      capabilities: ["write"],
      instructions: "",
      model: "custom/model",
      tools: [],
      modelRequirements: { minCapabilities: ["write"], costTier: "standard" },
      risk: "medium",
      context: {
        sandbox: { type: "cloud", workingDirectory: "/workspace" },
      } as any,
      termination: { maxConsecutiveFailures: 1, allowsUserInput: false },
    };
    const registry = createSpecialistRegistry([custom]);
    expect(registry.get("coder")?.model).toBe("custom/model");
    expect(registry.get("coder")?.risk).toBe("medium");
  });

  it("all default specialists have unique roles", () => {
    const roles = DEFAULT_SPECIALISTS.map((s) => s.role);
    const unique = new Set(roles);
    expect(unique.size).toBe(roles.length);
  });

  it("SPECIALIST_TO_SUBAGENT maps explorer and coder", () => {
    expect(SPECIALIST_TO_SUBAGENT.explorer).toBe("explorer");
    expect(SPECIALIST_TO_SUBAGENT.coder).toBe("executor");
  });
});
