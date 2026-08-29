import { describe, expect, it } from "bun:test";
import {
  PlanningFailure,
  BudgetFailure,
  CancellationFailure,
  ModelFailure,
  SandboxFailure,
  PermissionFailure,
  ConfigurationFailure,
  classifyError,
  isRecoverable,
  redactSecrets,
} from "./errors";

describe("errors", () => {
  it("creates typed failures", () => {
    const e = new PlanningFailure("no tasks");
    expect(e.failureClass).toBe("planning");
    expect(e.name).toBe("PlanningFailure");
    expect(e.isCancellation).toBe(false);
  });

  it("cancellation sets isCancellation", () => {
    const e = new CancellationFailure("operator abort");
    expect(e.isCancellation).toBe(true);
    expect(e.failureClass).toBe("cancellation");
  });

  it("classifyError passes through existing IntelligenceError", () => {
    const original = new PlanningFailure("nope");
    expect(classifyError(original)).toBe(original);
  });

  it("classifyError maps AbortError to cancellation", () => {
    const e = classifyError(new DOMException("timeout", "AbortError"));
    expect(e.failureClass).toBe("cancellation");
    expect(e.isCancellation).toBe(true);
  });

  it("classifyError maps unknown Error to fallback class", () => {
    const e = classifyError(new Error("boom"), "tool");
    expect(e.failureClass).toBe("tool");
    expect(e.isCancellation).toBe(false);
  });

  it("classifyError strings are redacted", () => {
    const e = classifyError("API_KEY=sk-12345 failed");
    expect(e.message).not.toContain("sk-12345");
    expect(e.message).toContain("[REDACTED]");
  });

  it("classifyError preserves AgentError kind metadata", () => {
    const agentErr = Object.assign(new Error("denied"), {
      kind: "permission",
      metadata: { code: "E403", retryable: false },
    });
    const e = classifyError(agentErr);
    expect(e.failureClass).toBe("permission");
    expect(e.metadata.code).toBe("E403");
  });

  it("isRecoverable classifies correctly", () => {
    expect(isRecoverable(new ModelFailure("model fail"))).toBe(true);
    expect(isRecoverable(new SandboxFailure("sandbox fail"))).toBe(true);
    expect(isRecoverable(new PermissionFailure("permission fail"))).toBe(false);
    expect(isRecoverable(new ConfigurationFailure("config fail"))).toBe(false);
  });

  it("redactSecrets masks known patterns", () => {
    const msg = redactSecrets(
      "token=ghp_1234567890abcdef and sk-abcdefghijklmnopqrst",
    );
    expect(msg).not.toContain("ghp_1234567890abcdef");
    expect(msg).not.toContain("sk-abc123");
    expect(msg).toContain("[REDACTED]");
  });

  it("BudgetFailure is typed correctly", () => {
    const e = new BudgetFailure("exceeded");
    expect(e.failureClass).toBe("budget");
    const e2 = classifyError(e);
    expect(e2.failureClass).toBe("budget");
  });
});
