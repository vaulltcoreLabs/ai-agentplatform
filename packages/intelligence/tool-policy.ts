/**
 * Vaulltcore Intelligence — tool policy engine.
 *
 * Policy-driven tool selection. For each task the policy engine resolves:
 *
 *   task → required capabilities → permitted tools → risk → approval
 *
 * Reuses the Phase 1 `VaulltcoreTool` / `ToolMetadata` contract (identity,
 * risk, category, permissions). Tools must expose metadata sufficient for
 * intelligent routing; the defaults extend the Phase 1 `DEFAULT_TOOL_RISK`
 * map with capability + routing tags.
 */

import type { ToolMetadata } from "@vaulltcore/agent";
import type { Capability } from "./specialists";
import type { ExecutionPolicy } from "./policy";

export interface ToolRouting {
  /** Tool name as exposed to the model. */
  readonly name: string;
  /** Metadata including risk, category, and capability tags. */
  readonly metadata: ToolMetadata;
  /** Capabilities the tool exercises. */
  readonly capabilities: readonly Capability[];
  /** Whether the tool requires network access. */
  readonly network: boolean;
  /** Whether the tool requires a sandbox. */
  readonly sandbox: boolean;
  /** Estimated relative cost (0 = trivial, 1 = moderate, 5 = expensive). */
  readonly cost: number;
  /** Whether the tool's effect is reversible. */
  readonly reversible: boolean;
  /** Whether use requires explicit approval under the default policy. */
  readonly approvalRequired: boolean;
}

export type ApprovalDecision = "auto" | "required" | "denied";

export interface ToolPolicyDecision {
  readonly tool: string;
  readonly allowed: boolean;
  readonly reason: string;
  readonly approval: ApprovalDecision;
}

export interface ToolPolicyEngine {
  /** All tools the policy knows about. */
  readonly tools: ReadonlyArray<ToolRouting>;
  /** Permit only tools whose capabilities are allowed by the task + policy. */
  permit(
    taskCapabilities: readonly Capability[],
    policy: ExecutionPolicy,
  ): ToolPolicyDecision[];
  /** Decision for a single tool. */
  decide(toolName: string, policy: ExecutionPolicy): ToolPolicyDecision;
  /** Tools usable by a given specialist role. */
  bySpecialist(role: string): readonly string[];
}

/**
 * Default tool routing table. Extends the Phase 1 `DEFAULT_TOOL_RISK` map with
 * capability tags and routing metadata used by the intelligent router. These
 * mirror the existing `packages/agent/tools/*` set — not new tools.
 */
export const DEFAULT_TOOL_ROUTING: ReadonlyArray<ToolRouting> = [
  {
    name: "read",
    metadata: {
      name: "read",
      risk: "safe",
      category: "filesystem",
      permissions: ["fs-read"],
    },
    capabilities: ["read"],
    network: false,
    sandbox: true,
    cost: 0,
    reversible: true,
    approvalRequired: false,
  },
  {
    name: "write",
    metadata: {
      name: "write",
      risk: "requires-approval",
      category: "filesystem",
      permissions: ["fs-write"],
    },
    capabilities: ["write"],
    network: false,
    sandbox: true,
    cost: 1,
    reversible: false,
    approvalRequired: true,
  },
  {
    name: "edit",
    metadata: {
      name: "edit",
      risk: "requires-approval",
      category: "filesystem",
      permissions: ["fs-write"],
    },
    capabilities: ["write"],
    network: false,
    sandbox: true,
    cost: 1,
    reversible: false,
    approvalRequired: true,
  },
  {
    name: "grep",
    metadata: {
      name: "grep",
      risk: "safe",
      category: "search",
      permissions: ["fs-read"],
    },
    capabilities: ["read", "search"],
    network: false,
    sandbox: true,
    cost: 0,
    reversible: true,
    approvalRequired: false,
  },
  {
    name: "glob",
    metadata: {
      name: "glob",
      risk: "safe",
      category: "search",
      permissions: ["fs-read"],
    },
    capabilities: ["read", "search"],
    network: false,
    sandbox: true,
    cost: 0,
    reversible: true,
    approvalRequired: false,
  },
  {
    name: "bash",
    metadata: {
      name: "bash",
      risk: "requires-approval",
      category: "shell",
      permissions: ["shell", "execute"],
    },
    capabilities: ["execute", "debug"],
    network: true,
    sandbox: true,
    cost: 2,
    reversible: false,
    approvalRequired: true,
  },
  {
    name: "web_fetch",
    metadata: {
      name: "web_fetch",
      risk: "safe",
      category: "web",
      permissions: ["network"],
    },
    capabilities: ["read"],
    network: true,
    sandbox: false,
    cost: 1,
    reversible: true,
    approvalRequired: false,
  },
  {
    name: "task",
    metadata: {
      name: "task",
      risk: "requires-approval",
      category: "orchestration",
      permissions: ["orchestration"],
    },
    capabilities: ["plan"],
    network: false,
    sandbox: false,
    cost: 3,
    reversible: false,
    approvalRequired: true,
  },
  {
    name: "ask_user_question",
    metadata: {
      name: "ask_user_question",
      risk: "safe",
      category: "ui",
      permissions: ["ui"],
    },
    capabilities: ["plan"],
    network: false,
    sandbox: false,
    cost: 0,
    reversible: false,
    approvalRequired: false,
  },
  {
    name: "todo_write",
    metadata: {
      name: "todo_write",
      risk: "safe",
      category: "orchestration",
      permissions: ["orchestration"],
    },
    capabilities: ["plan"],
    network: false,
    sandbox: false,
    cost: 0,
    reversible: true,
    approvalRequired: false,
  },
  {
    name: "skill",
    metadata: {
      name: "skill",
      risk: "safe",
      category: "skill",
      permissions: ["skill"],
    },
    capabilities: ["read", "plan"],
    network: false,
    sandbox: true,
    cost: 1,
    reversible: true,
    approvalRequired: false,
  },
];

const SPECIALIST_TOOLS: Readonly<Record<string, readonly string[]>> = {
  explorer: ["read", "grep", "glob", "bash"],
  planner: ["todo_write", "ask_user_question", "read", "grep", "glob"],
  architect: [
    "todo_write",
    "ask_user_question",
    "read",
    "grep",
    "glob",
    "skill",
  ],
  coder: [
    "read",
    "write",
    "edit",
    "grep",
    "glob",
    "bash",
    "todo_write",
    "task",
  ],
  debugger: ["read", "grep", "glob", "bash", "todo_write"],
  tester: ["read", "grep", "glob", "bash", "todo_write"],
  reviewer: ["read", "grep", "glob", "bash", "todo_write"],
  "security-reviewer": ["read", "grep", "glob", "bash", "todo_write"],
  "performance-reviewer": ["read", "grep", "glob", "bash", "todo_write"],
  "documentation-agent": [
    "read",
    "write",
    "edit",
    "grep",
    "glob",
    "bash",
    "todo_write",
  ],
  "release-agent": [
    "read",
    "write",
    "edit",
    "grep",
    "glob",
    "bash",
    "todo_write",
    "task",
  ],
  verifier: ["read", "bash", "grep", "glob", "todo_write"],
};

export function createToolPolicyEngine(
  routing: ReadonlyArray<ToolRouting> = DEFAULT_TOOL_ROUTING,
): ToolPolicyEngine {
  const byName = new Map(routing.map((r) => [r.name, r]));

  const approvalFor = (
    tool: ToolRouting,
    policy: ExecutionPolicy,
  ): ApprovalDecision => {
    const risk = tool.metadata.risk;
    if (policy.approval === "deny") return "denied";
    if (risk === "forbidden" || risk === "restricted") {
      return policy.approval === "manual-required" ? "required" : "denied";
    }
    if (tool.approvalRequired) {
      return "required";
    }
    return "auto";
  };

  return {
    tools: routing,
    permit(taskCapabilities, policy): ToolPolicyDecision[] {
      const allowed = new Set(taskCapabilities);
      return routing.map((tool) => {
        const capsMatch = tool.capabilities.some((c) => allowed.has(c));
        const networkOk =
          !tool.network ||
          policy.network === "full" ||
          policy.allowedCapabilities.includes("network-restricted");
        return {
          tool: tool.name,
          allowed: capsMatch && networkOk,
          reason: capsMatch
            ? networkOk
              ? "capability match"
              : "network restricted"
            : "capability mismatch",
          approval:
            capsMatch && networkOk
              ? approvalFor(tool, policy)
              : ("denied" as ApprovalDecision),
        };
      });
    },
    decide(toolName, policy): ToolPolicyDecision {
      const tool = byName.get(toolName);
      if (!tool) {
        return {
          tool: toolName,
          allowed: false,
          reason: "unknown tool",
          approval: "denied",
        };
      }
      const capsOk =
        policy.allowedCapabilities.length === 0 ||
        tool.capabilities.some((c) => policy.allowedCapabilities.includes(c));
      if (!capsOk) {
        return {
          tool: toolName,
          allowed: false,
          reason: "capability not permitted by policy",
          approval: "denied",
        };
      }
      return {
        tool: toolName,
        allowed: true,
        reason: "permitted",
        approval: approvalFor(tool, policy),
      };
    },
    bySpecialist(role: string): readonly string[] {
      return SPECIALIST_TOOLS[role] ?? [];
    },
  };
}

export const defaultToolPolicyEngine: ToolPolicyEngine =
  createToolPolicyEngine();
