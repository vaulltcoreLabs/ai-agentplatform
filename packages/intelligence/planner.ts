/**
 * Vaulltcore Intelligence — planner.
 *
 * The planner transforms a high-level objective into an ordered, dependency-
 * aware set of tasks (a `JobPlanSnapshot`) executed by named specialists.
 *
 * Phase 3 ships a deterministic, rule-based default planner (`DefaultPlanner`)
 * that decomposes common engineering objectives into the specialist pipeline:
 *
 *   Objective → Understand → Plan → Decompose → [specialist tasks]
 *
 * The planner is a pure function of (objective, context, specialists, policy)
 * → plan. It never mutates global state. A `PlanningBackend` interface allows
 * a future model-driven planner to plug in without changing the orchestrator.
 */

import { createTaskId, taskInputSignature } from "./ids";
import type { VcoreId } from "./ids";
import type {
  JobPlanSnapshot,
  RepositoryContext,
  ConstraintSet,
  TaskSpec,
} from "./job-model";
import type { ExecutionPolicy } from "./policy";
import type { SpecialistRegistry, Capability } from "./specialists";

export interface PlanningContext {
  readonly objective: string;
  readonly repository?: RepositoryContext;
  readonly constraints: ConstraintSet;
  readonly capabilities: readonly string[];
  readonly policy: ExecutionPolicy;
  readonly tenantId: string;
  readonly jobId: VcoreId;
  readonly contextPath: (taskId: string) => string[];
}

export interface PlanningResult {
  readonly plan: JobPlanSnapshot;
  readonly missing: readonly string[];
  readonly confidence: number;
}

export interface PlanningBackend {
  plan(
    ctx: PlanningContext,
    specialists: SpecialistRegistry,
  ): Promise<PlanningResult>;
}

function makeTask(
  jobId: string,
  name: string,
  specialist: string,
  dependsOn: string[],
  input: unknown,
): TaskSpec {
  return {
    id: createTaskId(jobId, taskInputSignature(specialist, { name, input })),
    name,
    specialist,
    dependsOn,
    input,
  };
}

/**
 * Deterministic, rule-based planner. Decomposes an objective into the
 * canonical engineering pipeline, reusing the specialist registry to pick
 * appropriate roles. Tasks are ordered by dependency; the final task always
 * "verifies" the prior work.
 */
export class DefaultPlanner implements PlanningBackend {
  async plan(
    ctx: PlanningContext,
    specialists: SpecialistRegistry,
  ): Promise<PlanningResult> {
    const jobId = ctx.jobId;
    const objective = ctx.objective;
    const missing: string[] = [];

    const explorer = specialists.get("explorer");
    const architect =
      specialists.get("architect") ?? specialists.get("planner");
    const coder = specialists.get("coder");
    const tester = specialists.get("tester");
    const reviewer = specialists.get("reviewer");
    const verifier = specialists.get("verifier");

    if (!explorer) missing.push("explorer");
    if (!verifier) missing.push("verifier");

    const tasks: TaskSpec[] = [
      // 1. Explore
      makeTask(
        jobId,
        "Explore repository for context",
        explorer?.role ?? "explorer",
        [],
        {
          task: "Understand the repository structure and relevant code for the objective",
          instructions: `Objective: ${objective}\nRepository: ${JSON.stringify(ctx.repository ?? {})}\nConstraints: ${JSON.stringify(ctx.constraints)}`,
        },
      ),
    ];
    const exploreId = tasks[0]!.id;

    // 2. Plan
    const planTask = makeTask(
      jobId,
      "Plan implementation",
      architect?.role ?? "architect",
      [exploreId],
      {
        task: "Produce an implementation plan from exploration findings",
        instructions: `Objective: ${objective}\nUse the exploration results to produce a step-by-step plan.`,
      },
    );
    tasks.push(planTask);

    // 3. Optionally code / test / review, then verify.
    const verifyRole = verifier?.role ?? "verifier";

    if (coder) {
      const codeTask = makeTask(
        jobId,
        "Implement changes",
        "coder",
        [planTask.id],
        {
          task: "Implement the plan",
          instructions: `Objective: ${objective}\nFollow the plan produced by the architect.`,
        },
      );
      tasks.push(codeTask);

      const testTask = tester
        ? makeTask(jobId, "Run tests", "tester", [codeTask.id], {
            task: "Validate implementation with tests",
            instructions: `Objective: ${objective}`,
          })
        : undefined;
      if (testTask) tasks.push(testTask);

      const reviewTask =
        reviewer && testTask
          ? makeTask(
              jobId,
              "Review changes",
              "reviewer",
              [codeTask.id, testTask!.id],
              {
                task: "Review code and tests",
                instructions: `Objective: ${objective}`,
              },
            )
          : undefined;
      if (reviewTask) tasks.push(reviewTask);

      const verifyDeps = reviewTask
        ? [reviewTask.id]
        : testTask
          ? [testTask.id]
          : [codeTask.id];

      tasks.push(
        makeTask(jobId, "Verify completion", verifyRole, verifyDeps, {
          task: "Independently verify the objective is achieved",
          instructions:
            "Produce structured evidence (compilation, tests, lint, type safety, changed files).",
        }),
      );
    } else if (verifier) {
      tasks.push(
        makeTask(jobId, "Verify completion", verifyRole, [planTask.id], {
          task: "Independently verify the objective is achievable",
          instructions: `Objective: ${objective}`,
        }),
      );
    }

    const order = tasks.map((t) => t.id);

    const plan: JobPlanSnapshot = {
      taskIds: order,
      order,
      tasks,
    };

    return {
      plan,
      missing,
      confidence: missing.length === 0 ? 0.8 : 0.3,
    };
  }
}

/** Select the capability tags a task requires based on its specialist. */
export function taskCapabilities(specialist: string): readonly Capability[] {
  switch (specialist) {
    case "explorer":
      return ["read", "search"];
    case "architect":
    case "planner":
      return ["plan", "design"];
    case "coder":
      return ["write", "execute", "test"];
    case "debugger":
      return ["debug", "execute"];
    case "tester":
      return ["test"];
    case "reviewer":
    case "security-reviewer":
    case "performance-reviewer":
      return ["review"];
    case "documentation-agent":
      return ["document"];
    case "release-agent":
      return ["release"];
    case "verifier":
      return ["verify"];
    default:
      return ["read"];
  }
}
