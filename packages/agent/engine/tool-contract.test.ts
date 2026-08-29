import { describe, expect, it } from "bun:test";
import type { Tool } from "ai";
import { defineTool, DEFAULT_TOOL_RISK, toolMetadata } from "./tool-contract";

describe("tool contract", () => {
  it("exposes a risk classification for the existing tool set", () => {
    for (const name of [
      "read",
      "grep",
      "glob",
      "todo_write",
      "web_fetch",
      "ask_user_question",
      "skill",
      "write",
      "edit",
      "bash",
      "task",
    ]) {
      expect(DEFAULT_TOOL_RISK[name]).toBeDefined();
    }
    expect(DEFAULT_TOOL_RISK.read).toBe("safe");
    expect(DEFAULT_TOOL_RISK.bash).toBe("requires-approval");
  });

  it("wraps an existing tool with metadata without duplicating logic", () => {
    const baseTool = {
      description: "Echo a value.",
      inputSchema: {} as unknown,
      execute: async (input: { value: string }) => input.value,
    } as unknown as Tool<{ value: string }, string>;
    const wrapped = defineTool({
      metadata: toolMetadata("echo", "shell"),
      tool: baseTool,
    });
    expect(wrapped.metadata.name).toBe("echo");
    expect(wrapped.metadata.risk).toBe("requires-approval");
  });
});
