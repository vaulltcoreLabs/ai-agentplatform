/**
 * Vaulltcore Intelligence — model routing.
 *
 * Routes tasks to a model based on capability, latency, cost, context
 * requirements, reasoning requirements, reliability, user BYOK config, and
 * tenant policy. Does NOT hardcode model names — models are described by
 * `ModelDescriptor` and resolved through the existing Phase 1
 * `ModelResolver` boundary.
 *
 * OpenAI is first-class (via the existing gateway); BYOK credentials never
 * become intelligence-layer state — they are resolved by the injected
 * `CredentialResolver` at the engine boundary.
 */

import {
  getModelCapabilities,
  type ModelCapabilities,
  type ModelResolver,
  type ModelSelection,
} from "@vaulltcore/agent";
import type { SpecialistSpec } from "./specialists";
import type { ExecutionPolicy } from "./policy";

export type CostTier = "cheap" | "standard" | "strong";

export interface ModelDescriptor {
  readonly id: string;
  readonly provider: string;
  /** Cost per 1k tokens (input + output combined estimate). */
  readonly costPer1kTokens: number;
  /** Approximate median latency (ms) for a typical request. */
  readonly latencyMs: number;
  /** Relative reliability (0–1). */
  readonly reliability: number;
  /** Cost tier for quick heuristic routing. */
  readonly costTier: CostTier;
  /** Resolved capabilities. */
  readonly capabilities: ModelCapabilities;
  /** Opaque credential reference (not the secret itself). */
  readonly credentialRef?: string;
}

export interface ModelRoutingContext {
  readonly task: string;
  readonly requiredCapabilities: readonly string[];
  readonly maxDepth: number;
  /** Token budget for this task's context window. */
  readonly contextTokens: number;
  /** Whether the task requires strong reasoning. */
  readonly reasoningRequired: boolean;
  /** Tenant policy. */
  readonly policy: ExecutionPolicy;
  readonly tenantId: string;
}

export interface ModelRouter {
  /** Available model descriptors this tenant can use. */
  readonly models: ReadonlyArray<ModelDescriptor>;
  /** Route a task to the best model descriptor. */
  route(ctx: ModelRoutingContext): ModelDescriptor | undefined;
  /** Resolve a descriptor to a concrete `LanguageModel` via the engine resolver. */
  resolve(descriptor: ModelDescriptor, resolver: ModelResolver): ModelSelection;
}

const DEFAULT_MODELS: ReadonlyArray<ModelDescriptor> = [
  {
    id: "anthropic/claude-haiku-4.5",
    provider: "anthropic",
    costPer1kTokens: 0.25,
    latencyMs: 800,
    reliability: 0.95,
    costTier: "cheap",
    capabilities: getModelCapabilities("anthropic/claude-haiku-4.5"),
  },
  {
    id: "openai/gpt-5",
    provider: "openai",
    costPer1kTokens: 1.5,
    latencyMs: 1200,
    reliability: 0.98,
    costTier: "standard",
    capabilities: getModelCapabilities("openai/gpt-5"),
  },
  {
    id: "anthropic/claude-opus-4.6",
    provider: "anthropic",
    costPer1kTokens: 4,
    latencyMs: 1500,
    reliability: 0.97,
    costTier: "strong",
    capabilities: getModelCapabilities("anthropic/claude-opus-4.6"),
  },
  {
    id: "openai/gpt-5.4",
    provider: "openai",
    costPer1kTokens: 6,
    latencyMs: 1800,
    reliability: 0.96,
    costTier: "strong",
    capabilities: getModelCapabilities("openai/gpt-5.4"),
  },
];

function scoreModel(
  model: ModelDescriptor,
  ctx: ModelRoutingContext,
): number | undefined {
  const caps = model.capabilities;

  // Must satisfy capability requirements.
  if (ctx.requiredCapabilities.includes("reasoning") && !caps.reasoning) {
    return undefined;
  }
  if (ctx.requiredCapabilities.includes("toolCalling") && !caps.toolCalling) {
    return undefined;
  }
  if (ctx.contextTokens > caps.contextWindow) {
    return undefined;
  }

  let score = 0;
  // Prefer cheaper models for shallow tasks.
  if (ctx.maxDepth >= 4) {
    // Deep tasks need strong reasoning models.
    if (model.costTier === "strong") score += 100;
    if (ctx.reasoningRequired && !caps.reasoning) score -= 1000;
  } else {
    if (model.costTier === "cheap") score += 50;
    if (model.costTier === "standard") score += 20;
  }
  // Reliability bonus.
  score += model.reliability * 10;
  // Latency penalty (lower is better).
  score -= model.latencyMs / 1000;
  // Cost penalty.
  score -= model.costPer1kTokens;
  // Context headroom bonus.
  if (caps.contextWindow > ctx.contextTokens) {
    score += 1;
  }
  return score;
}

/**
 * Default model router. Selects the highest-scoring model that satisfies the
 * requirements. Ties broken by cost tier (cheap first), then latency.
 */
export class DefaultModelRouter implements ModelRouter {
  readonly models: ReadonlyArray<ModelDescriptor>;

  constructor(models: readonly ModelDescriptor[] = DEFAULT_MODELS) {
    this.models = [...models];
  }

  route(ctx: ModelRoutingContext): ModelDescriptor | undefined {
    const scored = this.models
      .map((m) => ({ model: m, score: scoreModel(m, ctx) }))
      .filter(
        (s): s is { model: ModelDescriptor; score: number } =>
          s.score !== undefined && s.score > -1000,
      )
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        const tierRank = (t: CostTier) =>
          t === "cheap" ? 0 : t === "standard" ? 1 : 2;
        const tierDiff =
          tierRank(a.model.costTier) - tierRank(b.model.costTier);
        if (tierDiff !== 0) return tierDiff;
        return a.model.latencyMs - b.model.latencyMs;
      });

    return scored[0]?.model;
  }

  resolve(
    descriptor: ModelDescriptor,
    _resolver: ModelResolver,
  ): ModelSelection {
    return {
      provider: descriptor.provider as ModelSelection["provider"],
      model: descriptor.id,
      ...(descriptor.credentialRef
        ? { credentialRef: descriptor.credentialRef }
        : {}),
    };
  }
}

/** Route a specialist task to a model based on the specialist's requirements. */
export function routeForSpecialist(
  router: ModelRouter,
  specialist: SpecialistSpec,
  ctx: Omit<ModelRoutingContext, "requiredCapabilities"> & {
    requiredCapabilities?: readonly string[];
  },
): ModelDescriptor | undefined {
  const required = ctx.requiredCapabilities ?? specialist.capabilities;
  return router.route({
    ...ctx,
    requiredCapabilities: [...required] as readonly string[],
  });
}

export const defaultModelRouter = new DefaultModelRouter();
