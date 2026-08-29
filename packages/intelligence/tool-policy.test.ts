import { describe, expect, it } from "bun:test";
import { createToolPolicyEngine, DEFAULT_TOOL_ROUTING } from "./tool-policy";
import { DEFAULT_EXECUTION_POLICY } from "./policy";
import type { ExecutionPolicy } from "./policy";

describe("tool-policy", () => {
  it("has a standard set of tools", () => {
    expect(DEFAULT_TOOL_ROUTING.some((t) => t.name === "read")).toBe(true);
    expect(DEFAULT_TOOL_ROUTING.some((t) => t.name === "write")).toBe(true);
    expect(DEFAULT_TOOL_ROUTING.some((t) => t.name === "bash")).toBe(true);
    expect(DEFAULT_TOOL_ROUTING.some((t) => t.name === "task")).toBe(true);
  });

  it("permits tools by capability", () => {
    const engine = createToolPolicyEngine();
    const decisions = engine.permit(
      ["write", "execute"],
      DEFAULT_EXECUTION_POLICY,
    );
    const write = decisions.find((d) => d.tool === "write");
    expect(write!.allowed).toBe(true);
    const read = decisions.find((d) => d.tool === "read");
    expect(read!.allowed).toBe(false);
  });

  it("blocks network tools when network is restricted", () => {
    const engine = createToolPolicyEngine();
    const restricted: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      network: "egress-restricted",
      allowedCapabilities: ["read"],
    };
    const decisions = engine.permit(["read"], restricted);
    const webFetch = decisions.find((d) => d.tool === "web_fetch");
    expect(webFetch!.allowed).toBe(false);
  });

  it("allows network tools when network is full", () => {
    const engine = createToolPolicyEngine();
    const full: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      network: "full",
      allowedCapabilities: ["read"],
    };
    const decisions = engine.permit(["read"], full);
    const webFetch = decisions.find((d) => d.tool === "web_fetch");
    expect(webFetch!.allowed).toBe(true);
  });

  it("requires approval for destructive tools", () => {
    const engine = createToolPolicyEngine();
    const decisions = engine.permit(["write"], DEFAULT_EXECUTION_POLICY);
    const write = decisions.find((d) => d.tool === "write");
    expect(write!.approval).toBe("required");
  });

  it("auto-approves safe tools", () => {
    const engine = createToolPolicyEngine();
    const decisions = engine.permit(["read"], DEFAULT_EXECUTION_POLICY);
    const read = decisions.find((d) => d.tool === "read");
    expect(read!.approval).toBe("auto");
  });

  it("decide returns denied for unknown tools", () => {
    const engine = createToolPolicyEngine();
    const d = engine.decide("nonexistent", DEFAULT_EXECUTION_POLICY);
    expect(d.allowed).toBe(false);
    expect(d.approval).toBe("denied");
  });

  it("bySpecialist returns tool names for a role", () => {
    const engine = createToolPolicyEngine();
    const tools = engine.bySpecialist("coder");
    expect(tools).toContain("read");
    expect(tools).toContain("write");
    expect(tools).toContain("bash");
  });

  it("bySpecialist returns empty for unknown role", () => {
    const engine = createToolPolicyEngine();
    expect(engine.bySpecialist("nonexistent")).toEqual([]);
  });

  it("deny policy denies all", () => {
    const engine = createToolPolicyEngine();
    const denyPolicy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      approval: "deny",
      allowedCapabilities: [],
    };
    const decisions = engine.permit(["read"], denyPolicy);
    for (const d of decisions) {
      if (d.allowed) {
        expect(d.approval).not.toBe("auto");
      }
    }
  });
});
