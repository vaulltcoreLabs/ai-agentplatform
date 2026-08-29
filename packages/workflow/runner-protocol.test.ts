/**
 * Phase 4.5 — runner protocol tests (Workstreams E, F, L subset).
 *
 * IMPLEMENTED here: credential lifecycle (issue/authenticate/revoke), tenant
 * scope enforcement, handshake state machine legality, assignment timeout
 * path, stale-result fencing rejection.
 * FUTURE: real WebSocket transport, durable credential store.
 */

import { describe, expect, it } from "bun:test";
import {
  RunnerControlPlane,
  RunnerProtocolError,
  RunnerRegistry,
  RunnerSession,
  type ExecutionEnvelope,
  type RunnerIdentity,
} from "./runner-protocol";

function identity(overrides: Partial<RunnerIdentity> = {}): RunnerIdentity {
  return {
    runnerId: "runner-1",
    tenantScope: "tenant_a",
    capabilities: ["docker", "filesystem"],
    version: "1.0.0",
    ...overrides,
  };
}

function envelope(
  overrides: Partial<ExecutionEnvelope> = {},
): ExecutionEnvelope {
  const base = {
    tenantId: "tenant_a",
    runId: "drun_testrun1234567890123456789012",
    taskId: "dtask_testtask123456789012345678901",
    stepId: "dstep_teststep123456789012345678901",
    executionId: "exec_1",
    messageId: "msg_1",
    idempotencyKey: "idem_1",
    fencingToken: 3,
    timestamp: Date.now(),
  };
  return { ...base, ...overrides };
}

describe("RunnerRegistry — credential lifecycle", () => {
  it("authenticates a valid runner", () => {
    const registry = new RunnerRegistry();
    const token = registry.register(identity());
    expect(registry.authenticate("runner-1", token).runnerId).toBe("runner-1");
  });

  it("rejects an invalid token", () => {
    const registry = new RunnerRegistry();
    registry.register(identity());
    expect(() => registry.authenticate("runner-1", "wrong")).toThrow(
      RunnerProtocolError,
    );
  });

  it("rejects an unknown runner before any work assignment", () => {
    const registry = new RunnerRegistry();
    expect(() => registry.authenticate("ghost", "token")).toThrow(
      /unknown runner/,
    );
  });

  it("revocation is permanent and immediate", () => {
    const registry = new RunnerRegistry();
    const token = registry.register(identity());
    expect(registry.authenticate("runner-1", token)).toBeDefined();

    registry.revoke("runner-1");
    expect(() => registry.authenticate("runner-1", token)).toThrow(/revoked/);
  });
});

describe("RunnerSession — handshake state machine", () => {
  it("follows the full happy path", () => {
    const session = new RunnerSession(identity());
    const path: RunnerSession["state"][] = [
      "AUTHENTICATED",
      "READY",
      "ASSIGNED",
      "LEASED",
      "EXECUTING",
      "REPORTING",
      "COMPLETED",
      "ACKNOWLEDGED",
      "READY",
    ];
    for (const to of path) session.transition(to);
    expect(session.state).toBe("READY");
  });

  it("rejects illegal transitions (e.g. CONNECTING → EXECUTING)", () => {
    const session = new RunnerSession(identity());
    expect(() => session.transition("EXECUTING")).toThrow(/illegal transition/);
  });

  it("supports reconnect after disconnect", () => {
    const session = new RunnerSession(identity());
    session.transition("AUTHENTICATED");
    session.transition("DISCONNECTED");
    expect(() => session.transition("AUTHENTICATED")).not.toThrow();
  });

  it("assignment timeout returns the session to READY", () => {
    const session = new RunnerSession(identity());
    session.transition("AUTHENTICATED");
    session.transition("READY");
    session.transition("ASSIGNED"); // work offered, never leased
    session.transition("READY"); // timeout → re-assignable elsewhere
    expect(session.state).toBe("READY");
  });
});

describe("RunnerControlPlane — authorization & fencing", () => {
  function readySession(scope: string): RunnerSession {
    const session = new RunnerSession(identity({ tenantScope: scope }));
    session.transition("AUTHENTICATED");
    session.transition("READY");
    return session;
  }

  it("assigns work within the runner's tenant scope", () => {
    const plane = new RunnerControlPlane();
    const session = readySession("tenant_a");
    expect(() => plane.assign(session, envelope())).not.toThrow();
    expect(session.state).toBe("ASSIGNED");
  });

  it("denies cross-tenant assignment (tenant B work → tenant A runner)", () => {
    const plane = new RunnerControlPlane();
    const session = readySession("tenant_a");
    expect(() =>
      plane.assign(session, envelope({ tenantId: "tenant_b" })),
    ).toThrow(/not scoped for tenant/);
  });

  it("accepts platform-managed runners scoped to all tenants", () => {
    const plane = new RunnerControlPlane();
    const session = readySession("*");
    expect(() => plane.assign(session, envelope())).not.toThrow();
  });

  it("rejects a stale result carrying a superseded fencing token", () => {
    const plane = new RunnerControlPlane();
    const session = readySession("tenant_a");

    // Step is assigned twice (worker A crashed; lease reclaimed by worker B).
    plane.assign(session, envelope({ fencingToken: 5 }));
    session.transition("LEASED");
    session.transition("EXECUTING");
    // Worker A's late result carries the OLD token.
    expect(() =>
      plane.receiveResult(session, envelope({ fencingToken: 3 })),
    ).toThrow(RunnerProtocolError);
  });

  it("accepts a result whose fencing token matches the assignment", () => {
    const plane = new RunnerControlPlane();
    const session = readySession("tenant_a");
    plane.assign(session, envelope({ fencingToken: 5 }));
    // Runner leases and begins execution before reporting (legal path).
    session.transition("LEASED");
    session.transition("EXECUTING");
    expect(() =>
      plane.receiveResult(session, envelope({ fencingToken: 5 })),
    ).not.toThrow();
    expect(session.state).toBe("REPORTING");
  });

  it("refuses assignment when the session is not READY", () => {
    const plane = new RunnerControlPlane();
    const session = new RunnerSession(identity());
    expect(() => plane.assign(session, envelope())).toThrow(/not ready/);
  });
});
