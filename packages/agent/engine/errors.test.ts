import { describe, expect, it } from "bun:test";
import {
  AgentError,
  CancellationError,
  ConfigurationError,
  ModelError,
  PermissionError,
  redactSecrets,
  SandboxError,
  SubagentError,
  ToolError,
  ContextError,
  wrapError,
  isAgentError,
} from "./errors";

describe("errors", () => {
  it("redacts API keys and tokens from messages", () => {
    const input =
      "request failed: Authorization: Bearer sk-1234567890abcdef token=ghp_abcdef1234567890 and api_key=secret-value";
    const out = redactSecrets(input);
    expect(out).not.toContain("sk-1234567890abcdef");
    expect(out).not.toContain("ghp_abcdef1234567890");
    expect(out).not.toContain("secret-value");
    expect(out).toContain("[REDACTED]");
  });

  it("preserves non-sensitive diagnostic context", () => {
    const err = new ModelError("rate limited", {
      provider: "anthropic",
      model: "anthropic/claude-opus-4.6",
      retryable: true,
    });
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe("model");
    expect(err.metadata.provider).toBe("anthropic");
    expect(err.metadata.retryable).toBe(true);
    expect(err.message).toBe("rate limited");
  });

  it("supports all taxonomy kinds", () => {
    expect(new ToolError("x").kind).toBe("tool");
    expect(new PermissionError("x").kind).toBe("permission");
    expect(new SandboxError("x").kind).toBe("sandbox");
    expect(new ContextError("x").kind).toBe("context");
    expect(new SubagentError("x").kind).toBe("subagent");
    expect(new ConfigurationError("x").kind).toBe("configuration");
  });

  it("detects cancellation from abort errors", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const wrapped = wrapError(abort, { kind: "model" });
    expect(wrapped).toBeInstanceOf(CancellationError);
    expect(wrapped.isCancellation).toBe(true);
  });

  it("wraps unknown values without leaking secrets", () => {
    const wrapped = wrapError(new Error("Bearer sk-SECRET exposed in detail"), {
      kind: "tool",
      metadata: { tool: "bash" },
    });
    expect(wrapped).toBeInstanceOf(AgentError);
    expect(wrapped.message).not.toContain("sk-SECRET");
    expect(wrapped.metadata.tool).toBe("bash");
  });

  it("isAgentError narrows correctly", () => {
    expect(isAgentError(new ModelError("x"))).toBe(true);
    expect(isAgentError(new Error("x"))).toBe(false);
    expect(isAgentError("x")).toBe(false);
  });
});
