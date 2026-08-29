import { describe, expect, it } from "bun:test";
import { TenantScope, type TenantConfig } from "./tenant";
import type { RunBudget } from "./model";

const TENANT = "tenant_test";
const DEFAULT_BUDGET: RunBudget = {
  maxRuntimeMs: 60_000,
  maxModelCalls: 10,
  maxToolCalls: 20,
  maxInputTokens: 100_000,
  maxOutputTokens: 50_000,
};

function makeConfig(overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    tenantId: TENANT,
    maxConcurrentRuns: 2,
    maxConcurrentSteps: 4,
    defaultBudget: DEFAULT_BUDGET,
    ...overrides,
  };
}

describe("TenantScope — registration & ownership", () => {
  it("registers a tenant config", () => {
    const scope = new TenantScope();
    scope.register(makeConfig());
    expect(scope.getConfig(TENANT)).toBeDefined();
    expect(scope.getConfig(TENANT)!.maxConcurrentRuns).toBe(2);
  });

  it("returns undefined for unregistered tenant", () => {
    const scope = new TenantScope();
    expect(scope.getConfig("unknown")).toBeUndefined();
  });

  it("owns returns true for matching tenant", () => {
    const scope = new TenantScope();
    expect(scope.owns(TENANT, TENANT)).toBe(true);
  });

  it("owns returns false for different tenant", () => {
    const scope = new TenantScope();
    expect(scope.owns(TENANT, "other")).toBe(false);
  });
});

describe("TenantScope — run quotas", () => {
  it("allows run within quota", () => {
    const scope = new TenantScope();
    scope.register(makeConfig({ maxConcurrentRuns: 2 }));
    expect(scope.canStartRun(TENANT).allowed).toBe(true);
    scope.incrementRuns(TENANT);
    scope.incrementRuns(TENANT);
    expect(scope.canStartRun(TENANT).allowed).toBe(false);
    expect(scope.canStartRun(TENANT).reason).toBe(
      "max concurrent runs exceeded",
    );
  });

  it("denies run for unregistered tenant", () => {
    const scope = new TenantScope();
    expect(scope.canStartRun("unknown").allowed).toBe(false);
    expect(scope.canStartRun("unknown").reason).toBe("tenant not registered");
  });

  it("decrements runs correctly", () => {
    const scope = new TenantScope();
    scope.register(makeConfig({ maxConcurrentRuns: 1 }));
    scope.incrementRuns(TENANT);
    expect(scope.canStartRun(TENANT).allowed).toBe(false);
    scope.decrementRuns(TENANT);
    expect(scope.canStartRun(TENANT).allowed).toBe(true);
  });

  it("does not go below zero", () => {
    const scope = new TenantScope();
    scope.register(makeConfig());
    scope.decrementRuns(TENANT);
    expect(scope.liveRunCount(TENANT)).toBe(0);
  });
});

describe("TenantScope — step quotas", () => {
  it("allows step within quota", () => {
    const scope = new TenantScope();
    scope.register(makeConfig({ maxConcurrentSteps: 2 }));
    expect(scope.canStartStep(TENANT).allowed).toBe(true);
    scope.incrementSteps(TENANT);
    scope.incrementSteps(TENANT);
    expect(scope.canStartStep(TENANT).allowed).toBe(false);
  });

  it("denies step for unregistered tenant", () => {
    const scope = new TenantScope();
    expect(scope.canStartStep("unknown").allowed).toBe(false);
  });
});
