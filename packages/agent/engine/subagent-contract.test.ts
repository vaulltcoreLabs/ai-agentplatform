import { describe, expect, it } from "bun:test";
import { isSubagentResult, type SubagentResult } from "./subagent-contract";

describe("subagent contract", () => {
  it("validates a normalized subagent result", () => {
    const result: SubagentResult<{ summary: string }> = {
      output: { summary: "done" },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          noCacheTokens: 10,
        },
        outputTokenDetails: {
          textTokens: 5,
          reasoningTokens: 0,
        },
      },
      modelId: "anthropic/claude-opus-4.6",
    };
    expect(isSubagentResult(result)).toBe(true);
  });

  it("rejects non-results", () => {
    expect(isSubagentResult(null)).toBe(false);
    expect(isSubagentResult({ output: 1 })).toBe(false);
    expect(isSubagentResult("nope")).toBe(false);
  });
});
