import { describe, expect, it } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
import {
  createVaulltcoreAgent,
  CancellationError,
  type EngineEvent,
} from "./index";
import type { AgentSandboxContext } from "../vaulltcore-agent";

function fakeSandbox(): AgentSandboxContext {
  return {
    state: { type: "cloud" },
    workingDirectory: "/repo",
  } as unknown as AgentSandboxContext;
}

function buildMockOptions(
  doStream: (...args: unknown[]) => Promise<unknown>,
): ConstructorParameters<typeof MockLanguageModelV3>[0] {
  return { doStream } as unknown as ConstructorParameters<
    typeof MockLanguageModelV3
  >[0];
}

function textModel(chunks: Array<Record<string, unknown>>): LanguageModel {
  const doStream = async () => ({ stream: simulateReadableStream({ chunks }) });
  return new MockLanguageModelV3(
    buildMockOptions(doStream as (...a: unknown[]) => Promise<unknown>),
  ) as unknown as LanguageModel;
}

/**
 * A model whose doStream never emits tokens and reacts to the abort signal by
 * erroring its stream, proving cancellation propagates into the engine.
 */
function abortableHangingModel(): LanguageModel {
  const doStream = async (options: unknown) => {
    const opts = options as { abortSignal?: AbortSignal };
    if (opts.abortSignal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const stream = new ReadableStream({
      start(controller) {
        opts.abortSignal?.addEventListener("abort", () => {
          controller.error(new DOMException("Aborted", "AbortError"));
        });
      },
    });
    return { stream };
  };
  return new MockLanguageModelV3(
    buildMockOptions(doStream as (...a: unknown[]) => Promise<unknown>),
  ) as unknown as LanguageModel;
}

const completionChunks: Array<Record<string, unknown>> = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "1" },
  { type: "text-delta", id: "1", delta: "Hello" },
  { type: "text-end", id: "1" },
  {
    type: "finish",
    usage: {
      inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
      totalTokens: 5,
    },
    finishReason: "stop",
  },
];

describe("VaulltcoreAgent", () => {
  it("exposes provider-neutral capabilities and initial state", () => {
    const agent = createVaulltcoreAgent({ model: "openai/gpt-5" });
    expect(agent.defaultModelId).toBe("openai/gpt-5");
    expect(agent.getCapabilities().toolCalling).toBe(true);
    expect(agent.getStatus()).toBe("idle");
    expect(agent.getState().usage).toBeUndefined();
  });

  it("resolves models through an injected resolver (no real Vercel gateway)", async () => {
    const spy = { called: false };
    const agent = createVaulltcoreAgent({
      model: "anthropic/claude-opus-4.6",
      modelResolver: (selection) => {
        spy.called = true;
        expect(selection.provider).toBe("anthropic");
        return textModel(completionChunks);
      },
    });
    const events: EngineEvent[] = [];
    for await (const ev of agent.stream("hi", { sandbox: fakeSandbox() })) {
      events.push(ev);
    }
    expect(spy.called).toBe(true);
    expect(events.some((e) => e.type === "agent.completed")).toBe(true);
    expect(agent.getUsage()?.totalTokens).toBe(5);
    expect(agent.getStatus()).toBe("completed");
  });

  it("propagates cancellation through the abort signal", async () => {
    const hanging = abortableHangingModel();

    const agent = createVaulltcoreAgent({
      model: "anthropic/claude-opus-4.6",
      modelResolver: () => hanging,
    });

    const run = (async () => {
      const events: EngineEvent[] = [];
      try {
        for await (const ev of agent.stream("hi", {
          sandbox: fakeSandbox(),
        })) {
          events.push(ev);
        }
      } catch (error) {
        return { events, error };
      }
      return { events };
    })();

    agent.stop();

    const { events, error } = await run;
    expect(agent.getStatus()).toBe("cancelled");
    expect(error).toBeInstanceOf(CancellationError);
    expect(events.some((e) => e.type === "agent.failed")).toBe(true);
  });
});
