import { describe, expect, it } from "bun:test";
import {
  ChaosInjector,
  CrashError,
  NoopChaosInjector,
  seededRng,
  type FaultPlan,
} from "./chaos";
import type { Step } from "./model";

const STEP_ID = "dstep_teststep123456789012345678901";

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: STEP_ID,
    runId: "drun_testrun1234567890123456789012",
    taskId: "dtask_testtask12345678901234567890",
    tenantId: "tenant_test",
    attempt: 1,
    taskIdRef: "main",
    status: "queued",
    createdAt: 1000,
    version: 0,
    ...overrides,
  } as Step;
}

describe("NoopChaosInjector", () => {
  it("never throws", async () => {
    const injector = new NoopChaosInjector();
    await expect(injector.inspect(makeStep())).resolves.toBeUndefined();
  });
});

describe("ChaosInjector — error fault", () => {
  it("throws when fault matches", async () => {
    const plan: FaultPlan = {
      tenantId: "tenant_test",
      seed: 1,
      faults: new Map([[STEP_ID, { type: "error", value: "model-down" }]]),
    };
    const injector = new ChaosInjector(seededRng(1));
    injector.install(plan);

    let thrown: unknown;
    try {
      await injector.inspect(makeStep());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("model-down");
  });

  it("does not throw when no fault plan for tenant", async () => {
    const injector = new ChaosInjector(seededRng(1));
    await expect(injector.inspect(makeStep())).resolves.toBeUndefined();
  });

  it("does not throw when fault plan has no matching step", async () => {
    const plan: FaultPlan = {
      tenantId: "tenant_test",
      seed: 1,
      faults: new Map([["other_step", { type: "error" }]]),
    };
    const injector = new ChaosInjector(seededRng(1));
    injector.install(plan);
    await expect(injector.inspect(makeStep())).resolves.toBeUndefined();
  });

  it("respects probability < 1", async () => {
    const plan: FaultPlan = {
      tenantId: "tenant_test",
      seed: 1,
      faults: new Map([[STEP_ID, { type: "error", probability: 0 }]]),
    };
    const injector = new ChaosInjector(seededRng(1));
    injector.install(plan);
    await expect(injector.inspect(makeStep())).resolves.toBeUndefined();
  });
});

describe("ChaosInjector — delay fault", () => {
  it("delays execution by the specified ms", async () => {
    const plan: FaultPlan = {
      tenantId: "tenant_test",
      seed: 1,
      faults: new Map([[STEP_ID, { type: "delay", value: 50 }]]),
    };
    const injector = new ChaosInjector(seededRng(1));
    injector.install(plan);

    const start = Date.now();
    await injector.inspect(makeStep());
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe("ChaosInjector — crash fault", () => {
  it("throws CrashError", async () => {
    const plan: FaultPlan = {
      tenantId: "tenant_test",
      seed: 1,
      faults: new Map([[STEP_ID, { type: "crash" }]]),
    };
    const injector = new ChaosInjector(seededRng(1));
    injector.install(plan);

    await expect(injector.inspect(makeStep())).rejects.toThrow(CrashError);
  });
});

describe("ChaosInjector — lease_revoke fault", () => {
  it("marks step as lease-revoked", async () => {
    const plan: FaultPlan = {
      tenantId: "tenant_test",
      seed: 1,
      faults: new Map([[STEP_ID, { type: "lease_revoke" }]]),
    };
    const injector = new ChaosInjector(seededRng(1));
    injector.install(plan);

    const step = makeStep();
    await injector.inspect(step);
    expect(ChaosInjector.isLeaseRevoked(step)).toBe(true);
  });
});

describe("seededRng", () => {
  it("produces deterministic sequences", () => {
    const r1 = seededRng(123);
    const r2 = seededRng(123);
    for (let i = 0; i < 10; i++) {
      expect(r1()).toBe(r2());
    }
  });

  it("different seeds produce different sequences", () => {
    const r1 = seededRng(1);
    const r2 = seededRng(2);
    expect(r1()).not.toBe(r2());
  });
});
