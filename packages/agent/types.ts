import type { SandboxState } from "@vaulltcore/sandbox";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { AgentSandboxContext } from "./vaulltcore-agent";
import type { SkillMetadata } from "./skills/types";

export const todoStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type TodoStatus = z.infer<typeof todoStatusSchema>;

export const todoItemSchema = z.object({
  id: z.string().describe("Unique identifier for the todo item"),
  content: z.string().describe("The task description"),
  status: todoStatusSchema.describe(
    "Current status. Only ONE task should be in_progress at a time.",
  ),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

export interface AgentContext {
  sandbox: AgentSandboxContext;
  skills?: SkillMetadata[];
  model: LanguageModel;
  subagentModel?: LanguageModel;
}

export interface SandboxExecutionContext {
  sandbox: AgentSandboxContext;
}

/**
 * Type guard for a `SandboxState`. Provider-neutral: it accepts any known
 * sandbox type rather than hardcoding a single provider. The
 * engine must depend only on the `Sandbox` contract, never a concrete provider.
 */
export function isSandboxState(value: unknown): value is SandboxState {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

export const EVICTION_THRESHOLD_BYTES = 80 * 1024;
