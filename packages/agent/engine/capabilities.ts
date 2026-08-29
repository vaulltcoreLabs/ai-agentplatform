/**
 * Vaulltcore Agent Engine — model capability system.
 *
 * The engine must never branch on raw provider/model strings (e.g.
 * `if model === "claude"`). Provider-specific behavior is isolated here: the
 * rest of the engine queries `capabilities.<capability>` instead.
 *
 * Only capabilities actually exercised by the engine today are included. New
 * capabilities should be added here with a concrete justification, not
 * speculatively.
 */

export interface ModelCapabilities {
  /** Multi-step reasoning / extended thinking support. */
  reasoning: boolean;
  /** Function/tool calling. */
  toolCalling: boolean;
  /** Image input understanding. */
  vision: boolean;
  /** Structured output / JSON schema adherence. */
  structuredOutput: boolean;
  /** Token streaming. */
  streaming: boolean;
  /** Multiple tool calls in a single turn. */
  parallelToolCalls: boolean;
  /** Prompt/input caching (cache_control). */
  inputCaching: boolean;
  /** Approximate context window in tokens. */
  contextWindow: number;
  /** Approximate max output tokens per response. */
  maxOutputTokens: number;
}

export type ModelProvider = "openai" | "anthropic" | "google" | "unknown";

export interface ModelCapabilityOverride {
  idPattern: RegExp;
  capabilities: Partial<ModelCapabilities>;
}

const PROVIDER_DEFAULTS: Record<ModelProvider, ModelCapabilities> = {
  anthropic: {
    reasoning: true,
    toolCalling: true,
    vision: true,
    structuredOutput: true,
    streaming: true,
    parallelToolCalls: true,
    inputCaching: true,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  },
  openai: {
    reasoning: true,
    toolCalling: true,
    vision: true,
    structuredOutput: true,
    streaming: true,
    parallelToolCalls: true,
    inputCaching: false,
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
  },
  google: {
    reasoning: true,
    toolCalling: true,
    vision: true,
    structuredOutput: true,
    streaming: true,
    parallelToolCalls: true,
    inputCaching: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  },
  unknown: {
    reasoning: false,
    toolCalling: true,
    vision: false,
    structuredOutput: false,
    streaming: true,
    parallelToolCalls: false,
    inputCaching: false,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
  },
};

/**
 * Per-model refinements. Provider adaptation belongs here, never in the runner.
 * Add entries only when a specific model deviates from its provider default.
 */
const MODEL_OVERRIDES: ModelCapabilityOverride[] = [
  // Legacy Anthropic Claude 3.x models without adaptive thinking.
  {
    idPattern: /anthropic\/claude-3/,
    capabilities: { reasoning: false, maxOutputTokens: 8_192 },
  },
  // Smaller Anthropic Haiku — tighter output ceiling.
  {
    idPattern: /anthropic\/claude-haiku-4\.\d/,
    capabilities: { maxOutputTokens: 8_192 },
  },
];

export function parseProvider(modelId: string): ModelProvider {
  if (modelId.startsWith("openai/")) return "openai";
  if (modelId.startsWith("anthropic/")) return "anthropic";
  if (modelId.startsWith("google/") || modelId.startsWith("gemini/")) {
    return "google";
  }
  return "unknown";
}

export function getModelCapabilities(modelId: string): ModelCapabilities {
  const provider = parseProvider(modelId);
  let capabilities: ModelCapabilities = { ...PROVIDER_DEFAULTS[provider] };

  for (const override of MODEL_OVERRIDES) {
    if (override.idPattern.test(modelId)) {
      capabilities = { ...capabilities, ...override.capabilities };
    }
  }

  return capabilities;
}

export function supportsCapability(
  modelId: string,
  capability: keyof ModelCapabilities,
): boolean | number {
  return getModelCapabilities(modelId)[capability];
}
