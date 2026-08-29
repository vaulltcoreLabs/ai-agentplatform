/* eslint-disable jsdoc/require-yields */
/* eslint-disable oxc/no-barrel-file */
/**
 * Vaulltcore Agent Engine — public boundary.
 *
 * `VaulltcoreAgent` is the canonical, provider-neutral entry point to the
 * engine. Nothing outside the engine needs to understand `ToolLoopAgent`
 * internals: callers use `run()`, `stream()`, `stop()`, `getCapabilities()`,
 * `getUsage()`, and `getState()`.
 *
 * The engine is stateless with respect to durable application state. It receives
 * an execution context (messages, sandbox, model selection, abort signal) and
 * returns events, output, usage, and errors. Durability belongs to Phase 2.
 */

import { type LanguageModelUsage, type ModelMessage } from "ai";
import {
  createVaulltcoreAgent as createOpenAgentInstance,
  defaultModelLabel,
  type AgentSandboxContext,
  type VaulltcoreAgentCallOptions,
} from "../vaulltcore-agent";
import type { SkillMetadata } from "../skills/types";
import {
  getModelCapabilities,
  parseProvider,
  type ModelCapabilities,
} from "./capabilities";
import {
  createModelResolver,
  type ModelResolver,
  type ModelSelection,
} from "./model-resolution";
import type { ProviderOptionsByProvider } from "../models";
import {
  defaultPermissionResolver,
  type PermissionResolver,
} from "./permissions";
import { redactSecrets, wrapError } from "./errors";
import type { EngineEvent } from "./events";

export type VaulltcoreAgentStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface VaulltcoreRunOptions {
  sandbox: AgentSandboxContext;
  model?: string | ModelSelection;
  subagentModel?: string | ModelSelection;
  customInstructions?: string;
  skills?: SkillMetadata[];
  abortSignal?: AbortSignal;
}

export interface VaulltcoreRunResult {
  text: string;
  usage: LanguageModelUsage;
  steps: number;
}

export interface VaulltcoreAgentOptions {
  /** Default model for this agent instance. */
  model?: string | ModelSelection;
  /** Model resolver. Defaults to the managed Vaulltcore gateway. */
  modelResolver?: ModelResolver;
  /** Permission resolver (contract; enforced by future tool wiring). */
  permissionResolver?: PermissionResolver;
}

export interface VaulltcoreAgentState {
  status: VaulltcoreAgentStatus;
  model: string;
  runs: number;
  usage?: LanguageModelUsage;
}

type StreamPart = { type: string; [key: string]: unknown };

/**
 * Bridges the engine's provider-neutral `ModelResolver` to the agent's
 * `VaulltcoreAgentResolveModel` contract, preserving provider-options overrides.
 */
function bridgeResolver(engineResolver: ModelResolver) {
  return (selection: {
    id: string;
    providerOptionsOverrides?: ProviderOptionsByProvider;
  }) =>
    engineResolver({
      provider: parseProvider(selection.id),
      model: selection.id,
      runtimeConfig: { providerOptions: selection.providerOptionsOverrides },
    });
}

function modelIdToInput(model?: string | ModelSelection): string | undefined {
  if (!model) return undefined;
  return typeof model === "string" ? model : model.model;
}

function emptyUsage(): LanguageModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputTokenDetails: {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
    },
    outputTokenDetails: {
      textTokens: 0,
      reasoningTokens: 0,
    },
  };
}

export class VaulltcoreAgent {
  readonly defaultModelId: string;
  private readonly agent: ReturnType<typeof createOpenAgentInstance>;
  private readonly modelResolver: ModelResolver;
  private readonly permissionResolver: PermissionResolver;
  private readonly controller: AbortController;

  private status: VaulltcoreAgentStatus = "idle";
  private lastUsage?: LanguageModelUsage;
  private lastText = "";
  private lastSteps = 0;
  private runs = 0;

  constructor(options: VaulltcoreAgentOptions = {}) {
    this.defaultModelId =
      typeof options.model === "string"
        ? options.model
        : (options.model?.model ?? defaultModelLabel);
    this.modelResolver = options.modelResolver ?? createModelResolver();
    this.permissionResolver =
      options.permissionResolver ?? defaultPermissionResolver;
    this.agent = createOpenAgentInstance(bridgeResolver(this.modelResolver));
    this.controller = new AbortController();
  }

  /** Provider-neutral capability description for a model. */
  getCapabilities(modelId: string = this.defaultModelId): ModelCapabilities {
    return getModelCapabilities(modelId);
  }

  getStatus(): VaulltcoreAgentStatus {
    return this.status;
  }

  /** Normalized usage from the most recent run, if any. */
  getUsage(): LanguageModelUsage | undefined {
    return this.lastUsage;
  }

  getState(): VaulltcoreAgentState {
    return {
      status: this.status,
      model: this.defaultModelId,
      runs: this.runs,
      usage: this.lastUsage,
    };
  }

  /** Abort the current run and propagate to model, tools, and sandbox. */
  stop(): void {
    this.controller.abort();
  }

  /** Run to completion and return the aggregated result. */
  async run(
    input: string | ModelMessage[],
    options: VaulltcoreRunOptions,
  ): Promise<VaulltcoreRunResult> {
    // Drain the event stream; final state is read from the agent afterwards.
    for await (const _event of this.stream(input, options)) {
      void _event;
    }
    return {
      text: this.lastText,
      usage: this.lastUsage ?? emptyUsage(),
      steps: this.lastSteps,
    };
  }

  /**
   * Stream provider-neutral engine events. The final result text/usage is
   * available via `getUsage()` / `getState()` after the stream completes.
   */
  async *stream(
    input: string | ModelMessage[],
    options: VaulltcoreRunOptions,
  ): AsyncGenerator<EngineEvent> {
    const runId = `${this.defaultModelId}-${++this.runs}`;
    const signal = options.abortSignal ?? this.controller.signal;
    const modelId = modelIdToInput(options.model) ?? this.defaultModelId;

    this.status = "running";
    yield { type: "agent.started", runId, model: modelId };

    const callOptions: VaulltcoreAgentCallOptions = {
      sandbox: options.sandbox,
      model: modelIdToInput(options.model),
      subagentModel: modelIdToInput(options.subagentModel),
      customInstructions: options.customInstructions,
      skills: options.skills,
    };

    const base: Record<string, unknown> = {
      options: callOptions,
      abortSignal: signal,
    };
    const streamParams = (
      typeof input === "string"
        ? { ...base, prompt: input }
        : { ...base, messages: input }
    ) as Parameters<typeof this.agent.stream>[0];

    try {
      const stream = await this.agent.stream(streamParams);

      let text = "";
      for await (const raw of stream.fullStream) {
        const part = raw as unknown as StreamPart;
        switch (part.type) {
          case "text-delta": {
            const delta =
              typeof part.text === "string"
                ? part.text
                : typeof part.delta === "string"
                  ? part.delta
                  : "";
            text += delta;
            yield { type: "agent.message.delta", runId, text: delta };
            break;
          }
          case "tool-input-available":
          case "tool-call": {
            const tool = typeof part.toolName === "string" ? part.toolName : "";
            const toolCallId =
              typeof part.toolCallId === "string" ? part.toolCallId : "";
            yield { type: "agent.tool.started", runId, tool, toolCallId };
            break;
          }
          case "tool-result":
          case "tool-error": {
            const tool = typeof part.toolName === "string" ? part.toolName : "";
            const toolCallId =
              typeof part.toolCallId === "string" ? part.toolCallId : "";
            yield { type: "agent.tool.completed", runId, tool, toolCallId };
            break;
          }
          case "start":
            yield { type: "agent.thinking", runId };
            break;
          default:
            break;
        }
      }

      const [usage, steps, finalText] = await Promise.all([
        stream.usage,
        stream.steps,
        stream.text,
      ]);

      this.lastText = finalText || text;
      this.lastUsage = usage;
      this.lastSteps = steps.length;

      yield { type: "agent.usage", runId, usage, model: modelId };
      yield { type: "agent.message.completed", runId };
      yield { type: "agent.completed", runId, usage };
      this.status = "completed";
    } catch (err) {
      const wrapped = wrapError(err, { kind: "model" });
      this.status = wrapped.isCancellation ? "cancelled" : "failed";
      yield {
        type: "agent.failed",
        runId,
        error: { kind: wrapped.kind, message: redactSecrets(wrapped.message) },
      };
      throw wrapped;
    }
  }
}

export function createVaulltcoreAgent(
  options: VaulltcoreAgentOptions = {},
): VaulltcoreAgent {
  return new VaulltcoreAgent(options);
}

// Re-export the underlying engine contracts for convenience.
export * from "./errors";
export * from "./capabilities";
export * from "./model-resolution";
export * from "./permissions";
export * from "./tool-contract";
export * from "./subagent-contract";
export * from "./events";
