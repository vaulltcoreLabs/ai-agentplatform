/**
 * Vaulltcore Agent Engine — tool contract.
 *
 * Every tool the engine exposes carries a clean, self-describing contract:
 * identity, description, input/output schemas (inherited from the ai SDK Tool),
 * declared risk, and metadata. Tools remain independently testable and the
 * engine discovers them through this contract rather than hardcoding business
 * logic in the runner.
 *
 * Existing tools are wrapped — not rewritten — via `defineTool`.
 */

import type { Tool } from "ai";
import type { RiskLevel } from "./permissions";

export type ToolCategory =
  | "filesystem"
  | "shell"
  | "search"
  | "web"
  | "orchestration"
  | "ui"
  | "skill";

export interface ToolMetadata {
  /** Canonical tool name used by the model and permission resolver. */
  name: string;
  /** Risk classification driving the permission resolver. */
  risk: RiskLevel;
  category?: ToolCategory;
  /** Optional capability tags (e.g. "network", "fs-write"). */
  permissions?: string[];
  /** Arbitrary non-sensitive metadata. */
  [key: string]: unknown;
}

export type VaulltcoreTool<TArgs = unknown, TResult = unknown> = Tool<
  TArgs,
  TResult
> & {
  metadata: ToolMetadata;
};

export interface DefineToolSpec<TArgs = unknown, TResult = unknown> {
  metadata: ToolMetadata;
  /** Existing ai SDK tool (object or factory result). */
  tool: Tool<TArgs, TResult>;
}

export function defineTool<TArgs = unknown, TResult = unknown>(
  spec: DefineToolSpec<TArgs, TResult>,
): VaulltcoreTool<TArgs, TResult> {
  return { ...spec.tool, metadata: spec.metadata } as VaulltcoreTool<
    TArgs,
    TResult
  >;
}

/**
 * Risk classification for the existing Vaulltcore tool set. Read-only tools are
 * safe; mutating/destructive tools require approval. `.env` protection is
 * enforced inside the file tools regardless of this classification.
 */
export const DEFAULT_TOOL_RISK: Record<string, RiskLevel> = {
  read: "safe",
  grep: "safe",
  glob: "safe",
  todo_write: "safe",
  web_fetch: "safe",
  ask_user_question: "safe",
  skill: "safe",
  write: "requires-approval",
  edit: "requires-approval",
  bash: "requires-approval",
  task: "requires-approval",
};

export function toolMetadata(
  name: string,
  category: ToolCategory,
  risk: RiskLevel = DEFAULT_TOOL_RISK[name] ?? "requires-approval",
): ToolMetadata {
  return { name, category, risk };
}
