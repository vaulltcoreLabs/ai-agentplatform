/**
 * Vaulltcore Durable Execution — tenant scoping & quotas.
 *
 * Every durable operation is tenant-scoped for isolation. This module
 * provides a provider-neutral `TenantScope` that validates tenant ownership
 * and enforces simple concurrency / budget quotas.
 *
 * Quotas are advisory within a single process — a real deployment enforces
 * them via a shared meter (e.g. Redis-backed token bucket). The contract
 * remains: check before accepting work.
 */

import type { TenantId } from "./identity";
import type { RunBudget } from "./model";

export interface TenantConfig {
  readonly tenantId: TenantId;
  readonly maxConcurrentRuns: number;
  readonly maxConcurrentSteps: number;
  readonly defaultBudget: RunBudget;
}

export class TenantScope {
  private readonly configs = new Map<string, TenantConfig>();
  private readonly liveRuns = new Map<string, number>();
  private readonly liveSteps = new Map<string, number>();

  register(config: TenantConfig): void {
    this.configs.set(config.tenantId, config);
  }

  getConfig(tenantId: TenantId): TenantConfig | undefined {
    return this.configs.get(tenantId);
  }

  owns(tenantId: TenantId, resourceTenantId: TenantId): boolean {
    return tenantId === resourceTenantId;
  }

  canStartRun(tenantId: TenantId): { allowed: boolean; reason?: string } {
    const config = this.configs.get(tenantId);
    if (!config) {
      return { allowed: false, reason: "tenant not registered" };
    }
    const current = this.liveRuns.get(tenantId) ?? 0;
    if (current >= config.maxConcurrentRuns) {
      return { allowed: false, reason: "max concurrent runs exceeded" };
    }
    return { allowed: true };
  }

  canStartStep(tenantId: TenantId): { allowed: boolean; reason?: string } {
    const config = this.configs.get(tenantId);
    if (!config) {
      return { allowed: false, reason: "tenant not registered" };
    }
    const current = this.liveSteps.get(tenantId) ?? 0;
    if (current >= config.maxConcurrentSteps) {
      return { allowed: false, reason: "max concurrent steps exceeded" };
    }
    return { allowed: true };
  }

  incrementRuns(tenantId: TenantId): void {
    this.liveRuns.set(tenantId, (this.liveRuns.get(tenantId) ?? 0) + 1);
  }

  decrementRuns(tenantId: TenantId): void {
    const current = this.liveRuns.get(tenantId) ?? 0;
    this.liveRuns.set(tenantId, Math.max(0, current - 1));
  }

  incrementSteps(tenantId: TenantId): void {
    this.liveSteps.set(tenantId, (this.liveSteps.get(tenantId) ?? 0) + 1);
  }

  decrementSteps(tenantId: TenantId): void {
    const current = this.liveSteps.get(tenantId) ?? 0;
    this.liveSteps.set(tenantId, Math.max(0, current - 1));
  }

  liveRunCount(tenantId: TenantId): number {
    return this.liveRuns.get(tenantId) ?? 0;
  }
}
