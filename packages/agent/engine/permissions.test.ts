import { describe, expect, it } from "bun:test";
import {
  createRiskPermissionResolver,
  defaultPermissionResolver,
  DENY,
  ALLOW,
} from "./permissions";

describe("permission model", () => {
  it("allows safe tools by default", () => {
    expect(
      defaultPermissionResolver.resolve({ tool: "read", risk: "safe" }),
    ).toBe(ALLOW);
    expect(
      defaultPermissionResolver.resolve({ tool: "grep", risk: "safe" }),
    ).toBe(ALLOW);
  });

  it("requires approval for mutating tools", () => {
    const decision = defaultPermissionResolver.resolve({
      tool: "bash",
      risk: "requires-approval",
    });
    expect(decision.type).toBe("approve");
  });

  it("denies forbidden risk and explicitly forbidden tools", () => {
    const resolver = createRiskPermissionResolver({
      forbiddenTools: ["rm"],
    });
    expect(resolver.resolve({ tool: "rm", risk: "requires-approval" })).toBe(
      DENY,
    );
    expect(resolver.resolve({ tool: "bash", risk: "forbidden" })).toBe(DENY);
  });

  it("respects explicit allowlist", () => {
    const resolver = createRiskPermissionResolver({
      allowedTools: ["write"],
    });
    const decision = resolver.resolve({
      tool: "write",
      risk: "requires-approval",
    });
    expect(decision).toBe(ALLOW);
  });

  it("keeps approval source opaque to the engine", () => {
    const decision = defaultPermissionResolver.resolve({
      tool: "bash",
      risk: "requires-approval",
      input: "rm -rf /",
    });
    // The engine does not inspect the input; only the decision matters.
    expect(decision.type).toBe("approve");
    expect(decision.reason).toMatch(/bash/);
  });
});
