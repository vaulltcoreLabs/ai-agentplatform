/**
 * Vaulltcore Agent Engine — tool permission boundary.
 *
 * The engine distinguishes tool risk and resolves a decision through a
 * `PermissionResolver`. The source of approval (web UI, API, organization
 * policy, human reviewer, future policy engine) is opaque to the engine.
 *
 * Phase 1 creates the contract and preserves the spirit of current behavior
 * (read-only tools allowed; mutating/destructive tools require approval or are
 * denied). The future policy platform is NOT built here.
 */

export type RiskLevel =
  | "safe"
  | "requires-approval"
  | "restricted"
  | "forbidden";

export type PermissionDecisionType = "allow" | "approve" | "deny";

export interface PermissionDecision {
  type: PermissionDecisionType;
  /** Human-readable reason; must never contain secrets. */
  reason?: string;
}

export interface ToolRequest {
  /** Tool name (e.g. "bash", "read"). */
  tool: string;
  /** Tool-declared risk level. */
  risk: RiskLevel;
  /** Tool input (e.g. the shell command). Opaque to the resolver contract. */
  input?: unknown;
  /** Arbitrary non-sensitive metadata (cwd, model id, etc.). */
  metadata?: Record<string, unknown>;
}

export interface PermissionResolver {
  resolve(request: ToolRequest): PermissionDecision;
}

export const ALLOW: PermissionDecision = { type: "allow" };
export const DENY: PermissionDecision = {
  type: "deny",
  reason: "Tool is forbidden by policy.",
};

/**
 * Default risk-based resolver. Preserves the current convention that safe
 * read-only tools proceed while higher-risk tools require explicit approval or
 * are denied.
 */
export function createRiskPermissionResolver(
  overrides: {
    /** Tool names that are always denied regardless of risk. */
    forbiddenTools?: string[];
    /** Tool names that are always allowed regardless of risk. */
    allowedTools?: string[];
  } = {},
): PermissionResolver {
  const forbidden = new Set(overrides.forbiddenTools);
  const allowed = new Set(overrides.allowedTools);

  return {
    resolve(request: ToolRequest): PermissionDecision {
      if (forbidden.has(request.tool)) return DENY;

      if (request.risk === "forbidden") return DENY;
      if (allowed.has(request.tool) || request.risk === "safe") {
        return ALLOW;
      }
      if (request.risk === "requires-approval") {
        return {
          type: "approve",
          reason: `Tool "${request.tool}" requires approval.`,
        };
      }
      // "restricted" without an explicit allowlist entry requires approval too.
      return {
        type: "approve",
        reason: `Tool "${request.tool}" is restricted and requires approval.`,
      };
    },
  };
}

export const defaultPermissionResolver: PermissionResolver =
  createRiskPermissionResolver();
