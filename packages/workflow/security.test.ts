import { describe, expect, it } from "bun:test";
import {
  validateObjective,
  authorize,
  redactFailure,
  redactDurableEvent,
} from "./security";
import type { FailureRecord, DurableEvent } from "./model";

const TENANT = "tenant_test";

describe("security — validateObjective", () => {
  it("accepts a valid objective", () => {
    expect(validateObjective("build a web server")).toBeUndefined();
  });

  it("rejects empty objective", () => {
    expect(validateObjective("")).toBe("objective must not be empty");
  });

  it("rejects non-string", () => {
    expect(validateObjective(123 as unknown as string)).toBe(
      "objective must be a string",
    );
  });

  it("rejects objectives exceeding max length", () => {
    const long = "x".repeat(4097);
    expect(validateObjective(long)).toBe("objective exceeds max length (4096)");
  });

  it("rejects objectives with null bytes", () => {
    expect(validateObjective("build\0a server")).toBe(
      "objective must not contain null bytes",
    );
  });
});

describe("security — authorize", () => {
  it("allows same tenant", () => {
    expect(authorize(TENANT, TENANT)).toBe(true);
  });

  it("denies cross-tenant", () => {
    expect(authorize(TENANT, "other_tenant")).toBe(false);
  });
});

describe("security — redactFailure", () => {
  it("redacts secrets in message", () => {
    const failure: FailureRecord = {
      failureClass: "model",
      retryable: true,
      message: "API_KEY=sk-secret-123456789 failed",
      createdAt: 1000,
    };
    const redacted = redactFailure(failure);
    expect(redacted.message).not.toContain("sk-secret-123456789");
    expect(redacted.retryable).toBe(true);
    expect(redacted.failureClass).toBe("model");
  });

  it("preserves non-secret content", () => {
    const failure: FailureRecord = {
      failureClass: "timeout",
      retryable: true,
      message: "request timed out after 30000ms",
      createdAt: 1000,
    };
    expect(redactFailure(failure).message).toBe(
      "request timed out after 30000ms",
    );
  });
});

describe("security — redactDurableEvent", () => {
  it("redacts secrets in payload strings", () => {
    const event: DurableEvent = {
      eventId: "e1",
      runId: "r1",
      sequence: 1,
      type: "step.completed",
      timestamp: 1000,
      tenantId: TENANT,
      correlationId: "c1",
      payload: { error: "token=ghp_secrettoken123", msg: "ok" },
    };
    const redacted = redactDurableEvent(event);
    expect(redacted.payload.error).not.toContain("ghp_secrettoken123");
    expect(redacted.payload.msg).toBe("ok");
  });

  it("redacts secrets in nested arrays", () => {
    const event: DurableEvent = {
      eventId: "e1",
      runId: "r1",
      sequence: 1,
      type: "t",
      timestamp: 1000,
      tenantId: TENANT,
      correlationId: "c",
      payload: { list: ["token=abc123secret", "safe"] },
    };
    const redacted = redactDurableEvent(event);
    const list = redacted.payload.list as string[];
    expect(list[0]).not.toContain("abc123secret");
  });

  it("does not modify non-string payload fields", () => {
    const event: DurableEvent = {
      eventId: "e1",
      runId: "r1",
      sequence: 1,
      type: "t",
      timestamp: 1000,
      tenantId: TENANT,
      correlationId: "c",
      payload: { count: 42, flag: true, nested: { value: 99 } },
    };
    const redacted = redactDurableEvent(event);
    expect(redacted.payload.count).toBe(42);
    expect(redacted.payload.flag).toBe(true);
  });
});
