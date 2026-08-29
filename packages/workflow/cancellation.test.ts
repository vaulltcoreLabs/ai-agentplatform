import { describe, expect, it } from "bun:test";
import { CancellationHub } from "./cancellation";

const TENANT = "tenant_test";
const RUN_ID = "drun_testrun1234567890123456789012";

describe("CancellationHub", () => {
  it("registers and returns a signal", () => {
    const hub = new CancellationHub();
    const signal = hub.register(RUN_ID, TENANT);
    expect(signal.aborted).toBe(false);
  });

  it("cancels and fires the signal", () => {
    const hub = new CancellationHub();
    const signal = hub.register(RUN_ID, TENANT);
    hub.cancel(RUN_ID, TENANT, "operator", "manual cancel", 5000);
    expect(signal.aborted).toBe(true);
    expect(hub.isCancelled(RUN_ID, TENANT)).toBe(true);
  });

  it("is idempotent — cancel twice is safe", () => {
    const hub = new CancellationHub();
    hub.register(RUN_ID, TENANT);
    hub.cancel(RUN_ID, TENANT, "operator", "reason1", 5000);
    hub.cancel(RUN_ID, TENANT, "operator", "reason2", 6000);
    const state = hub.get(RUN_ID, TENANT);
    expect(state).toBeDefined();
    expect(state!.reason).toBe("reason1");
    expect(state!.requestedAt).toBe(5000);
  });

  it("isolates tenants", () => {
    const hub = new CancellationHub();
    hub.register(RUN_ID, TENANT);
    hub.cancel(RUN_ID, TENANT, "operator", "test", 5000);
    expect(hub.isCancelled(RUN_ID, TENANT)).toBe(true);
    expect(hub.isCancelled(RUN_ID, "other_tenant")).toBe(false);
  });

  it("unregisters a run after completion", () => {
    const hub = new CancellationHub();
    const signal = hub.register(RUN_ID, TENANT);
    hub.cancel(RUN_ID, TENANT, "operator", "done", 5000);
    expect(signal.aborted).toBe(true);
    hub.unregister(RUN_ID, TENANT);
    expect(hub.get(RUN_ID, TENANT)).toBeUndefined();
  });

  it("childSignal aborts immediately if parent already cancelled", () => {
    const hub = new CancellationHub();
    hub.register(RUN_ID, TENANT);
    hub.cancel(RUN_ID, TENANT, "operator", "test", 5000);
    const { signal } = hub.childSignal(RUN_ID, TENANT, "w1", 100_000, 6000);
    expect(signal.aborted).toBe(true);
  });

  it("childSignal respects deadline", () => {
    const hub = new CancellationHub();
    hub.register(RUN_ID, TENANT);
    const now = 1000;
    const { signal, timer } = hub.childSignal(
      RUN_ID,
      TENANT,
      "w1",
      now + 100,
      now,
    );
    expect(signal.aborted).toBe(false);
    timer.clear();
  });

  it("childSignal has no deadline → never aborts from timer", () => {
    const hub = new CancellationHub();
    hub.register(RUN_ID, TENANT);
    const { signal, timer } = hub.childSignal(
      RUN_ID,
      TENANT,
      "w1",
      undefined,
      1000,
    );
    expect(signal.aborted).toBe(false);
    timer.clear();
  });
});
