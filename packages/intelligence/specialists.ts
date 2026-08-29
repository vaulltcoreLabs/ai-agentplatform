/**
 * Vaulltcore Intelligence — specialist subagent system.
 *
 * Extends the Phase 1 `SubagentSpec` contract rather than replacing it.
 * Specialization is expressed through *capabilities* (a set of named
 * abilities) rather than hardcoded duplicated agents. Each specialist declares
 * its identity, capabilities, allowed tools, I/O shape, model requirements,
 * risk level, resource budget, and termination conditions.
 *
 * The set of specialists is extensible: Phase 1 ships `explorer`, `executor`,
 * and `design`; this layer generalizes them and adds the planning/verification
 * specialists needed for engineering execution intelligence.
 */

import type {
  SubagentBudget,
  SubagentSpec,
  ModelSelection,
} from "@vaulltcore/agent";

/** Capability a specialist may declare (and a task may request). */
export type Capability =
  | "read"
  | "write"
  | "execute"
  | "search"
  | "plan"
  | "verify"
  | "debug"
  | "review"
  | "test"
  | "design"
  | "document"
  | "release";

export type SpecialistRole =
  | "explorer"
  | "planner"
  | "architect"
  | "coder"
  | "debugger"
  | "reviewer"
  | "tester"
  | "security-reviewer"
  | "performance-reviewer"
  | "documentation-agent"
  | "release-agent"
  | "verifier";

/** Risk level a specialist operates at (drives approval policy). */
export type SpecialistRisk = "low" | "medium" | "high";

/**
 * Extended specialist spec. Augments `SubagentSpec` with capability-based
 * routing, risk, and termination conditions so the orchestrator can choose the
 * right specialist without hardcoding names.
 */
export interface SpecialistSpec extends SubagentSpec {
  /** Stable role identifier. */
  role: string;
  /** Engineering capabilities this specialist is competent at. */
  capabilities: Capability[];
  /** Model requirement hint (e.g. "reasoning", "cheap", "strong"). */
  modelRequirements: {
    /** Minimum model capability tags required. */
    minCapabilities: readonly string[];
    /** Preferred cost tier ("cheap" | "standard" | "strong"). */
    costTier: "cheap" | "standard" | "strong";
  };
  /** Risk classification driving approval boundaries. */
  risk: SpecialistRisk;
  /** Termination conditions beyond step limits. */
  termination: {
    /** Max consecutive failures before the specialist is replaced. */
    maxConsecutiveFailures: number;
    /** Whether the specialist may request user input (rare for subagents). */
    allowsUserInput: boolean;
  };
  /** Budget specific to this specialist. */
  specialistBudget?: SubagentBudget;
}

export interface SpecialistSelection {
  readonly role: string;
  readonly capabilities: readonly Capability[];
  readonly risk: SpecialistRisk;
  readonly modelSelection: ModelSelection | string;
}

export interface SpecialistRegistry {
  readonly specialists: ReadonlyMap<string, SpecialistSpec>;
  /** Look up a specialist by role. */
  get(role: string): SpecialistSpec | undefined;
  /** Select the best specialist for a required capability + risk ceiling. */
  select(
    required: readonly Capability[],
    riskCeiling?: SpecialistRisk,
  ): SpecialistSpec | undefined;
  /** All specialists qualified for at least one of the required capabilities. */
  query(required: readonly Capability[]): SpecialistSpec[];
}

const RISK_RANK: Record<SpecialistRisk, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function buildDefaultSpec(
  role: SpecialistRole,
  capabilities: Capability[],
  risk: SpecialistRisk,
  model: ModelSelection | string,
  budget?: SubagentBudget,
): SpecialistSpec {
  const base = {
    role,
    description: `${role} specialist`,
    capabilities,
    instructions: "",
    model,
    tools: [] as string[],
    modelRequirements: {
      minCapabilities: [...capabilities] as readonly string[],
      costTier:
        model === "anthropic/claude-haiku-4.5" ||
        (typeof model === "object" &&
          model.model === "anthropic/claude-haiku-4.5")
          ? "cheap"
          : "standard",
    },
    risk,
    termination: {
      maxConsecutiveFailures: 3,
      allowsUserInput: false,
    },
  } as SpecialistSpec;
  if (budget) {
    base.specialistBudget = budget;
  }
  return base;
}

/**
 * Default specialist catalogue. Each specialist maps to an existing Phase 1
 * subagent implementation at execution time; here we only declare the
 * *contract*. The mapping is resolved by the orchestrator via the
 * specialist→subagent bridge.
 */
export const DEFAULT_SPECIALISTS: ReadonlyArray<SpecialistSpec> = [
  buildDefaultSpec(
    "explorer",
    ["read", "search"],
    "low",
    "anthropic/claude-haiku-4.5",
  ),
  buildDefaultSpec(
    "architect",
    ["plan", "design"],
    "medium",
    "anthropic/claude-opus-4.6",
  ),
  buildDefaultSpec(
    "coder",
    ["write", "execute", "test"],
    "high",
    "anthropic/claude-opus-4.6",
  ),
  buildDefaultSpec(
    "debugger",
    ["debug", "execute"],
    "high",
    "anthropic/claude-opus-4.6",
  ),
  buildDefaultSpec("tester", ["test"], "medium", "anthropic/claude-haiku-4.5"),
  buildDefaultSpec(
    "reviewer",
    ["review"],
    "medium",
    "anthropic/claude-opus-4.6",
  ),
  buildDefaultSpec(
    "security-reviewer",
    ["review"],
    "high",
    "anthropic/claude-opus-4.6",
  ),
  buildDefaultSpec("verifier", ["verify"], "low", "anthropic/claude-haiku-4.5"),
];

export function createSpecialistRegistry(
  overrides: ReadonlyArray<SpecialistSpec> = [],
): SpecialistRegistry {
  const map = new Map<string, SpecialistSpec>();
  for (const spec of DEFAULT_SPECIALISTS) {
    map.set(spec.role, spec);
  }
  for (const spec of overrides) {
    map.set(spec.role, spec);
  }

  const query = (required: readonly Capability[]): SpecialistSpec[] => {
    const req = new Set(required);
    const matches = [...map.values()].filter((s) =>
      s.capabilities.some((c) => req.has(c)),
    );
    return matches.sort((a, b) => {
      const r = RISK_RANK[a.risk] - RISK_RANK[b.risk];
      return r !== 0 ? r : a.role.localeCompare(b.role);
    });
  };

  return {
    get: (role: string) => map.get(role),
    select: (required, riskCeiling) => {
      const candidates = query(required);
      if (riskCeiling !== undefined) {
        return candidates.find(
          (s) => RISK_RANK[s.risk] <= RISK_RANK[riskCeiling],
        );
      }
      return candidates[0];
    },
    query,
    specialists: map,
  };
}

/** Default singleton registry for convenience. */
export const defaultSpecialistRegistry: SpecialistRegistry =
  createSpecialistRegistry();

/**
 * Map a Phase 3 specialist role to a Phase 1 `SubagentType`, if a direct
 * implementation exists. Specialists without a direct Phase 1 implementation
 * are bridged through the agent engine at execution time.
 */
export const SPECIALIST_TO_SUBAGENT: Readonly<Record<string, string>> = {
  explorer: "explorer",
  coder: "executor",
  designer: "design",
};
