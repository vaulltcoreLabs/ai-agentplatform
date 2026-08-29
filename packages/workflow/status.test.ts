import { describe, expect, it } from "bun:test";
import {
  isTerminal,
  isActive,
  runCanTransition,
  stepCanTransition,
  runStatusToPhase3Status,
  stepStatusToPhase3Status,
} from "./status";

describe("status — terminal & active", () => {
  it("marks completed/failed/cancelled/expired as terminal", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
  });

  it("marks created/queued/running as non-terminal", () => {
    expect(isTerminal("created")).toBe(false);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });

  it("marks running and waiting as active", () => {
    expect(isActive("running")).toBe(true);
    expect(isActive("waiting")).toBe(true);
    expect(isActive("queued")).toBe(false);
  });
});

describe("status — run transitions", () => {
  it("allows created → queued", () => {
    expect(runCanTransition("created", "queued")).toBe(true);
  });

  it("does not allow completed → running (terminal)", () => {
    expect(runCanTransition("completed", "running")).toBe(false);
  });

  it("allows running → verifying", () => {
    expect(runCanTransition("running", "verifying")).toBe(true);
  });

  it("allows verifying → completed", () => {
    expect(runCanTransition("verifying", "completed")).toBe(true);
  });

  it("allows failed → queued (retry)", () => {
    expect(runCanTransition("failed", "queued")).toBe(true);
  });

  it("does not allow running → completed (must go through verifying)", () => {
    expect(runCanTransition("running", "completed")).toBe(false);
  });

  it("allows cancel_requested → cancelled", () => {
    expect(runCanTransition("cancel_requested", "cancelled")).toBe(true);
  });

  it("does not allow queued → paused for step (not in StepStatus)", () => {
    expect(runCanTransition("queued", "paused")).toBe(true);
  });
});

describe("status — step transitions", () => {
  it("allows created → queued", () => {
    expect(stepCanTransition("created", "queued")).toBe(true);
  });

  it("does not allow completed → running", () => {
    expect(stepCanTransition("completed", "running")).toBe(false);
  });

  it("allows failed → queued (retry)", () => {
    expect(stepCanTransition("failed", "queued")).toBe(true);
  });

  it("allows running → completed", () => {
    expect(stepCanTransition("running", "completed")).toBe(true);
  });

  it("allows running → waiting", () => {
    expect(stepCanTransition("running", "waiting")).toBe(true);
  });

  it("does not allow created → completed (must go through queued/running)", () => {
    expect(stepCanTransition("created", "completed")).toBe(false);
  });
});

describe("status — Phase 3 bridge", () => {
  it("maps durable → phase 3 job status", () => {
    expect(runStatusToPhase3Status("created")).toBe("pending");
    expect(runStatusToPhase3Status("running")).toBe("running");
    expect(runStatusToPhase3Status("verifying")).toBe("verifying");
    expect(runStatusToPhase3Status("completed")).toBe("completed");
    expect(runStatusToPhase3Status("failed")).toBe("failed");
    expect(runStatusToPhase3Status("cancelled")).toBe("cancelled");
  });

  it("returns undefined for pure-durability states", () => {
    expect(runStatusToPhase3Status("queued")).toBeUndefined();
    expect(runStatusToPhase3Status("retrying")).toBeUndefined();
    expect(runStatusToPhase3Status("paused")).toBeUndefined();
    expect(runStatusToPhase3Status("cancel_requested")).toBe("cancelled");
    expect(runStatusToPhase3Status("expired")).toBeUndefined();
  });

  it("maps step status → phase 3 task status", () => {
    expect(stepStatusToPhase3Status("queued")).toBe("ready");
    expect(stepStatusToPhase3Status("running")).toBe("running");
    expect(stepStatusToPhase3Status("completed")).toBe("completed");
    expect(stepStatusToPhase3Status("failed")).toBe("failed");
    expect(stepStatusToPhase3Status("cancelled")).toBe("cancelled");
    expect(stepStatusToPhase3Status("waiting")).toBe("blocked");
  });
});
