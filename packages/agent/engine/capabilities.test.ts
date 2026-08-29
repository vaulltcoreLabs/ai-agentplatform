import { describe, expect, it } from "bun:test";
import {
  getModelCapabilities,
  parseProvider,
  supportsCapability,
} from "./capabilities";

describe("model capabilities", () => {
  it("parses providers from model ids", () => {
    expect(parseProvider("anthropic/claude-opus-4.6")).toBe("anthropic");
    expect(parseProvider("openai/gpt-5")).toBe("openai");
    expect(parseProvider("google/gemini-2.0-pro")).toBe("google");
    expect(parseProvider("custom/thing")).toBe("unknown");
  });

  it("returns provider defaults without provider-specific branching in engine code", () => {
    const anthropic = getModelCapabilities("anthropic/claude-opus-4.6");
    expect(anthropic.toolCalling).toBe(true);
    expect(anthropic.reasoning).toBe(true);
    expect(anthropic.inputCaching).toBe(true);

    const openai = getModelCapabilities("openai/gpt-5");
    expect(openai.toolCalling).toBe(true);
    expect(openai.inputCaching).toBe(false);
  });

  it("applies per-model overrides for legacy anthropic models", () => {
    const legacy = getModelCapabilities("anthropic/claude-3-5-sonnet");
    expect(legacy.reasoning).toBe(false);
    expect(legacy.maxOutputTokens).toBe(8_192);
  });

  it("supports capability queries", () => {
    expect(supportsCapability("openai/gpt-5", "toolCalling")).toBe(true);
    expect(supportsCapability("anthropic/claude-3-5-sonnet", "reasoning")).toBe(
      false,
    );
  });
});
