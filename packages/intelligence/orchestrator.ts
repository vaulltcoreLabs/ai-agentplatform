/**
 * Vaulltcore Intelligence — orchestrator & engine entry point.
 *
 * The `VaulltcoreJobEngine` is the provider-neutral coordinator that owns the
 * engineering execution lifecycle:
 *
 *   Objective → Understand → Plan → Decompose → Schedule → Execute
 *   → Observe → Verify → Repair → Verify again → Complete
 *
 * It does NOT spawn subagents recursively. It maintains a controlled task
 * graph, schedules tasks under bounded concurrency, invokes specialists through
 * an injected `SpecialistRunner`, collects verification evidence, and drives a
 * bounded self-repair loop on failure.
 *
 * The engine depends only on:
 *  - `@vaulltcore/agent` (Agent Engine + subagent contract)
 *  - `@vaulltcore/sandbox` (Sandbox interface)
 * It does NOT depend on any cloud provider, database, or web framework.
 */

/* eslint-disable max-classes-per-file */

import {
  createVaulltcoreAgent,
  VaulltcoreAgent,
  type VaulltcoreAgentResolveModel,
  redactSecrets,
} from "@vaulltcore/agent";
import type { Sandbox, SandboxState } from "@vaulltcore/sandbox";
import {
  DEFAULT_EXECUTION_POLICY,
  applyPolicyOverride,
  type ExecutionPolicy,
  type PolicyOverride,
} from "./policy";
import { BudgetTracker, emptyBudget } from "./budget";
import { createJobId, type VcoreId } from "./ids";
import { newCorrelation, type CorrelationId } from "./correlation";
import {
  classifyError,
  IntelligenceError,
  PlanningFailure,
  type FailureClass,
} from "./errors";
import { buildTaskGraph, type TaskGraph } from "./task-graph";
import {
  DefaultPlanner,
  taskCapabilities,
  type PlanningBackend,
  type PlanningContext,
} from "./planner";
import {
  createSpecialistRegistry,
  defaultSpecialistRegistry,
  type SpecialistRegistry,
  type SpecialistSpec,
} from "./specialists";
import {
  type IntelligenceEvent,
  MemoryEventLog,
  type EventLog,
} from "./events";
import {
  JobAggregate,
  type JobOutcome,
  type JobPlanSnapshot,
  type JobSnapshot,
  type RepositoryContext,
  type TaskOutcome,
  type TaskRecord,
  type VerificationResult,
  type ArtifactRecord,
} from "./job-model";
import {
  scheduleExecution,
  type SchedulerCallbacks,
  type SchedulerDeps,
  type SchedulerResult,
  type EventLogger,
} from "./scheduler";
import {
  DefaultModelRouter,
  routeForSpecialist,
  type ModelRouter,
  type ModelDescriptor,
} from "./model-router";
import { defaultToolPolicyEngine, type ToolPolicyEngine } from "./tool-policy";
import {
  defaultVerifier,
  type VerificationBackend,
  type VerificationContext,
  type CheckSpec,
} from "./verification";
import { noopMemory, type MemoryContract } from "./memory";

/** Context needed to execute a single specialist task. */
export interface SpecialistRunInput {
  readonly task: TaskRecord;
  readonly correlation: CorrelationId;
  readonly objectives: string[];
  readonly input: unknown;
  readonly sandbox: Sandbox | undefined;
  readonly capabilities: readonly string[];
  readonly policy: ExecutionPolicy;
}

export interface SpecialistRunOutput {
  readonly output: unknown;
  readonly usage: Record<string, number>;
  readonly error?: {
    failureClass: string;
    message: string;
    code?: string;
    retryable?: boolean;
  };
  readonly artifacts: readonly ArtifactRecord[];
}

export interface SpecialistRunner {
  run(
    input: SpecialistRunInput,
    signal: AbortSignal,
  ): Promise<SpecialistRunOutput>;
}

/** Bridge the Phase 3 specialist model to the Phase 1 agent engine. */
export class EngineSpecialistRunner implements SpecialistRunner {
  readonly agentSupplier: () => VaulltcoreAgent;
  readonly modelResolver?: (
    model: string | ModelDescriptor,
  ) => VaulltcoreAgentResolveModel;
  readonly #specialistRegistry: SpecialistRegistry;
  readonly #modelRouter: ModelRouter | undefined;
  readonly #tenantId: string;
  readonly #policy: ExecutionPolicy;

  constructor(
    agentSupplier: (() => VaulltcoreAgent) | VaulltcoreAgent,
    specialistRegistry?: SpecialistRegistry,
    modelRouter?: ModelRouter,
    tenantId?: string,
    policy?: ExecutionPolicy,
  ) {
    this.agentSupplier =
      typeof agentSupplier === "function" ? agentSupplier : () => agentSupplier;
    this.#specialistRegistry = specialistRegistry ?? defaultSpecialistRegistry;
    this.#modelRouter = modelRouter;
    this.#tenantId = tenantId ?? "";
    this.#policy = policy ?? DEFAULT_EXECUTION_POLICY;
  }

  private get agent(): VaulltcoreAgent {
    return this.agentSupplier();
  }

  async run(
    input: SpecialistRunInput,
    signal: AbortSignal,
  ): Promise<SpecialistRunOutput> {
    const spec = this.resolveSpec(input.task.spec.specialist);

    const prompt = this.buildPrompt(input);
    const model = this.resolveModel(input.task.spec.specialist, input);
    try {
      const result = await this.agent.run(prompt, {
        sandbox: {
          state: {
            type: input.sandbox?.type ?? "cloud",
          } as unknown as SandboxState,
          workingDirectory: input.sandbox?.workingDirectory ?? "/workspace",
        },
        abortSignal: signal,
        customInstructions: spec?.description,
        ...(model ? { model } : {}),
      });

      return {
        output: result.text,
        usage: {
          totalTokens: result.usage.totalTokens ?? 0,
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
        artifacts: [],
      };
    } catch (err) {
      const classified = classifyError(err, "tool", input.correlation);
      return {
        output: undefined,
        usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
        error: {
          failureClass: classified.failureClass,
          message: classified.message,
          code: classified.metadata.code,
          retryable: classified.metadata.retryable ?? false,
        },
        artifacts: [],
      };
    }
  }

  private resolveSpec(role: string): SpecialistSpec | undefined {
    const spec = this.#specialistRegistry.get(role);
    if (spec) return spec;
    if (role === "default" || role === "executor") {
      return this.#specialistRegistry.get("coder");
    }
    return undefined;
  }

  private resolveModel(
    specialist: string,
    input: SpecialistRunInput,
  ): string | undefined {
    if (!this.#modelRouter) return undefined;
    const spec = this.resolveSpec(specialist);
    if (!spec) return undefined;
    const descriptor = routeForSpecialist(this.#modelRouter, spec, {
      task: input.task.spec.name,
      requiredCapabilities: spec.capabilities as readonly string[],
      maxDepth: this.#policy.maxDepth,
      contextTokens: this.#policy.maxInputTokens,
      reasoningRequired: spec.risk === "high",
      policy: this.#policy,
      tenantId: this.#tenantId,
    });
    return descriptor?.id;
  }

  private buildPrompt(input: SpecialistRunInput): string {
    const spec = input.task.spec;
    const taskDesc =
      typeof spec.input === "object" && spec.input !== null
        ? ((spec.input as { task?: string; instructions?: string }).task ??
          spec.name)
        : spec.name;
    const instructions =
      typeof spec.input === "object" && spec.input !== null
        ? ((spec.input as { instructions?: string }).instructions ?? "")
        : "";
    return `Task: ${taskDesc}\n\nInstructions:\n${instructions}`;
  }
}

export interface JobEngineOptions {
  readonly tenantId: string;
  readonly agent?: VaulltcoreAgent | VaulltcoreAgentOptions;
  readonly policy?: PolicyOverride;
  readonly specialists?: ReadonlyArray<SpecialistSpec>;
  readonly modelRouter?: ModelRouter;
  readonly toolPolicy?: ToolPolicyEngine;
  readonly planner?: PlanningBackend;
  readonly verifier?: VerificationBackend;
  readonly events?: EventLog;
  readonly memory?: MemoryContract;
  readonly resolveModel?: VaulltcoreAgentResolveModel;
  readonly runner?: SpecialistRunner;
}

interface VaulltcoreAgentOptions {
  model?: string;
  modelResolver?: (
    selection: import("@vaulltcore/agent").ModelSelection,
  ) => import("ai").LanguageModel;
}

export interface JobEngineRunOptions {
  readonly objective: string;
  readonly repository?: RepositoryContext;
  readonly constraints?: Record<string, unknown>;
  readonly capabilities?: readonly string[];
  readonly abortSignal?: AbortSignal;
  readonly checks?: readonly CheckSpec[];
}

export interface JobEngineResult {
  readonly jobId: string;
  readonly objective: string;
  readonly outcome: JobOutcome;
  readonly events: readonly IntelligenceEvent[];
  readonly finalCorrelation: CorrelationId;
}

export interface JobEngine {
  run(options: JobEngineRunOptions): Promise<JobEngineResult>;
  cancel(jobId: string): Promise<void>;
  getJob(jobId: string): Promise<JobSnapshot | undefined>;
  replay(jobId: string): Promise<readonly IntelligenceEvent[]>;
}

const DEFAULT_LOGGER: EventLogger = {
  warn: (msg: string) => console.warn(`[intelligence] ${msg}`),
  error: (msg: string) => console.error(`[intelligence] ${msg}`),
};

/** Convenience factory for creating a ``VaulltcoreJobEngine``. */
export function createVaulltcoreJobEngine(
  options: JobEngineOptions,
): VaulltcoreJobEngine {
  return new VaulltcoreJobEngine(options);
}

/**
 * The central Vaulltcore job coordinator. Owns the engine that coordinates
 * planning, scheduling, execution, verification, and repair under a structured
 * execution policy.
 */
export class VaulltcoreJobEngine implements JobEngine {
  readonly tenantId: string;
  readonly #agentOptions?: VaulltcoreAgent | VaulltcoreAgentOptions;
  #agentRef?: VaulltcoreAgent;
  readonly policy: ExecutionPolicy;
  readonly specialists: SpecialistRegistry;
  readonly modelRouter: ModelRouter;
  readonly toolPolicy: ToolPolicyEngine;
  readonly planner: PlanningBackend;
  readonly verifier: VerificationBackend;
  readonly events: EventLog;
  readonly memory: MemoryContract;
  readonly runner: SpecialistRunner;
  readonly #jobs = new Map<string, JobAggregate>();
  readonly #correlation = new Map<string, CorrelationId>();
  readonly #abortControllers = new Map<string, AbortController>();

  constructor(options: JobEngineOptions) {
    this.tenantId = options.tenantId;
    const policyOverride = options.policy;
    this.policy = policyOverride
      ? applyPolicyOverride(DEFAULT_EXECUTION_POLICY, policyOverride)
      : DEFAULT_EXECUTION_POLICY;
    this.specialists = createSpecialistRegistry(options.specialists);
    this.modelRouter = options.modelRouter ?? new DefaultModelRouter();
    this.toolPolicy = options.toolPolicy ?? defaultToolPolicyEngine;
    this.planner = options.planner ?? new DefaultPlanner();
    this.verifier = options.verifier ?? defaultVerifier;
    this.events = options.events ?? new MemoryEventLog();
    this.memory = options.memory ?? noopMemory;

    // Defer agent construction until a default runner is needed. When a custom
    // runner is injected the agent is never materialized.
    this.#agentOptions = options.agent;
    this.#agentRef =
      options.agent instanceof VaulltcoreAgent ? options.agent : undefined;
    this.runner =
      options.runner ??
      new EngineSpecialistRunner(
        () => this.#getAgent(),
        this.specialists,
        this.modelRouter,
        this.tenantId,
        this.policy,
      );
  }

  #getAgent(): VaulltcoreAgent {
    if (!this.#agentRef) {
      const opts = this.#agentOptions;
      this.#agentRef = createVaulltcoreAgent({
        model:
          opts && !(opts instanceof VaulltcoreAgent) ? opts.model : undefined,
        modelResolver:
          opts && !(opts instanceof VaulltcoreAgent)
            ? opts.modelResolver
            : undefined,
      });
    }
    return this.#agentRef!;
  }

  /**
   * Run an engineering objective to completion. Idempotent: the same objective
   * + tenant always yields the same job id, so re-submission resumes.
   */
  async run(options: JobEngineRunOptions): Promise<JobEngineResult> {
    const jobId = createJobId(this.tenantId, options.objective);

    // Idempotency: resume an existing job instead of duplicating.
    let job = this.#jobs.get(jobId);
    if (job) {
      return this.resumeOrCreate(job, options);
    }

    const correlation = newCorrelation(this.tenantId, jobId);
    this.#correlation.set(jobId, correlation);

    job = new JobAggregate({
      id: jobId,
      tenantId: this.tenantId,
      objective: options.objective,
      policy: this.policy,
      repository: options.repository,
      constraints: options.constraints ?? {},
      capabilities: [...(options.capabilities ?? [])],
      budget: emptyBudget(),
    });

    await this.events.append({
      type: "job.created",
      objective: options.objective,
      jobId,
      tenantId: this.tenantId,
      correlation,
    });

    return this.executeJob(job, correlation, options);
  }

  private async resumeOrCreate(
    job: JobAggregate,
    options: JobEngineRunOptions,
  ): Promise<JobEngineResult> {
    const correlation =
      this.#correlation.get(job.id) ?? newCorrelation(this.tenantId, job.id);
    this.#correlation.set(job.id, correlation);
    return this.executeJob(job, correlation, options);
  }

  private async executeJob(
    job: JobAggregate,
    correlation: CorrelationId,
    options: JobEngineRunOptions,
  ): Promise<JobEngineResult> {
    this.#jobs.set(job.id, job);
    const controller = new AbortController();
    this.#abortControllers.set(job.id, controller);

    const outerSignal = options.abortSignal;
    const linked = new AbortController();
    outerSignal?.addEventListener("abort", () => linked.abort());
    if (outerSignal?.aborted) {
      linked.abort();
    }
    const signal = linked.signal;

    const budget = new BudgetTracker(this.policy);

    try {
      // 1. Understand & Plan
      job.setStatus("planning");
      const plan = await this.plan(job, correlation, options, signal);
      job.setPlan(plan);
      await this.events.append({
        type: "job.planned",
        plan: {
          taskIds: [...plan.taskIds],
          specialistByTask: plan.tasks.map((t) => ({
            taskId: t.id,
            specialist: t.specialist,
          })),
        },
        tenantId: this.tenantId,
        correlation,
      });

      // 2. Build graph + schedule
      const graph = buildTaskGraph(plan.tasks);
      if (graph.hasCycle) {
        throw new PlanningFailure(
          `Task graph has a cycle: ${(graph.cycle ?? []).join(" → ")}`,
          { correlation },
        );
      }

      job.setStatus("running");
      const result = await this.scheduleAndRun(
        job,
        graph,
        budget,
        this.makeCallbacks(job, correlation),
        signal,
        correlation,
      );

      if (result.error) {
        if (result.error.isCancellation) {
          job.cancel(result.error.message);
          await this.events.append({
            type: "job.cancelled",
            reason: result.error.message,
            tenantId: this.tenantId,
            correlation,
          });
          return {
            jobId: job.id,
            objective: job.objective,
            outcome: job.outcome!,
            events: await this.events.replay(job.id),
            finalCorrelation: correlation,
          };
        } else {
          throw result.error;
        }
      }

      // If any tasks failed and couldn't be recovered, fail the job.
      if (result.failed.length > 0 && result.completed.length === 0) {
        const failedList = result.failed.join(", ");
        job.fail("tool", "Tasks failed: " + failedList);
        await this.events.append({
          type: "job.failed",
          outcome: job.outcome!,
          tenantId: this.tenantId,
          correlation,
        });
        return {
          jobId: job.id,
          objective: job.objective,
          outcome: job.outcome!,
          events: await this.events.replay(job.id),
          finalCorrelation: correlation,
        };
      }

      // 3. Verify
      job.setStatus("verifying");
      const verification = await this.verify(
        job,
        correlation,
        signal,
        options.checks,
      );
      job.setVerification(verification);
      await this.events.append({
        type: verification.passed
          ? "verification.passed"
          : "verification.failed",
        taskId: "",
        result: verification,
        tenantId: this.tenantId,
        correlation,
      });

      if (verification.passed) {
        job.complete(true, "verification passed");
        await this.events.append({
          type: "job.completed",
          outcome: job.outcome!,
          tenantId: this.tenantId,
          correlation,
        });
      } else {
        // 4. Repair loop
        const repaired = await this.repair(
          job,
          graph,
          budget,
          verification,
          this.makeCallbacks(job, correlation),
          signal,
          correlation,
        );
        if (repaired) {
          job.complete(true, "repair succeeded");
          await this.events.append({
            type: "job.completed",
            outcome: job.outcome!,
            tenantId: this.tenantId,
            correlation,
          });
        } else {
          job.fail("verification", "Verification failed after repair attempts");
          await this.events.append({
            type: "job.failed",
            outcome: job.outcome!,
            tenantId: this.tenantId,
            correlation,
          });
        }
      }

      return {
        jobId: job.id,
        objective: job.objective,
        outcome: job.outcome!,
        events: await this.events.replay(job.id),
        finalCorrelation: correlation,
      };
    } catch (err) {
      const classified = classifyError(err, "unknown", correlation);
      job.fail(classified.failureClass, classified.message);
      await this.events.append({
        type: "job.failed",
        outcome: job.outcome!,
        tenantId: this.tenantId,
        correlation,
      });
      return {
        jobId: job.id,
        objective: job.objective,
        outcome: job.outcome!,
        events: await this.events.replay(job.id),
        finalCorrelation: correlation,
      };
    } finally {
      this.#abortControllers.delete(job.id);
    }
  }

  private async plan(
    job: JobAggregate,
    correlation: CorrelationId,
    _options: JobEngineRunOptions,
    _signal: AbortSignal,
  ): Promise<JobPlanSnapshot> {
    const ctx: PlanningContext = {
      objective: job.objective,
      repository: job.repository,
      constraints: job.constraints,
      capabilities: job.capabilities,
      policy: this.policy,
      tenantId: job.tenantId,
      jobId: job.id as VcoreId,
      contextPath: () => [],
    };

    try {
      const result = await this.planner.plan(ctx, this.specialists);
      return result.plan;
    } catch (err) {
      throw new PlanningFailure(
        `Planning failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
        { cause: err, correlation },
      );
    }
  }

  private async scheduleAndRun(
    job: JobAggregate,
    graph: TaskGraph,
    budget: BudgetTracker,
    cb: SchedulerCallbacks,
    signal: AbortSignal,
    correlation: CorrelationId,
  ): Promise<SchedulerResult> {
    const deps: SchedulerDeps = {
      policy: this.policy,
      budget,
      log: DEFAULT_LOGGER,
    };
    const result = await scheduleExecution(deps, job, graph, cb, signal);

    // Record budget events.
    if (budget.exhausted) {
      const snapshot = budget.consumed;
      await this.events.append({
        type: "budget.breached",
        kind: "exhausted",
        consumed: snapshot.modelCalls,
        limit: this.policy.maxModelCalls,
        tenantId: this.tenantId,
        correlation,
      });
    }

    return result;
  }

  private async verify(
    job: JobAggregate,
    correlation: CorrelationId,
    signal: AbortSignal,
    checks?: readonly CheckSpec[],
  ): Promise<VerificationResult> {
    const ctx: VerificationContext = {
      sandbox: this.resolveSandbox(job),
      workingDirectory: job.repository?.workingDirectory ?? "/workspace",
      outcome: job.tasks.map(
        (t): TaskOutcome => ({
          taskId: t.spec.id,
          status: t.status,
          success: t.status === "completed",
          attempts: t.attempts.length,
          output: t.output,
        }),
      )[0] ?? { taskId: "", status: "completed", success: true, attempts: 0 },
      requirements: [...job.capabilities],
      signal,
    };
    return this.verifier.verify(ctx, checks ?? []);
  }

  private resolveSandbox(_job: JobAggregate): Sandbox | undefined {
    // In the default runner, the sandbox is provided per-task by the
    // SpecialistRunner. This stub returns undefined for the default verifier
    // (the verifier's own tests run in the runner's sandbox). A production
    // wiring injects a connected sandbox here.
    return undefined;
  }

  private async repair(
    job: JobAggregate,
    graph: TaskGraph,
    budget: BudgetTracker,
    verification: VerificationResult,
    cb: SchedulerCallbacks,
    signal: AbortSignal,
    correlation: CorrelationId,
  ): Promise<boolean> {
    const maxAttempts = this.policy.retry.maxRepairAttempts;
    const failedCheck = verification.failedChecks[0];
    const repair = verification.recommendedRepair;
    if (!repair || !failedCheck) {
      return false;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) {
        return false;
      }
      await this.events.append({
        type: "repair.started",
        taskId: failedCheck,
        attempt,
        reason: repair.reason,
        tenantId: this.tenantId,
        correlation,
      });

      // Create a synthetic repair task and execute it inline.
      const repairTask: TaskRecord = {
        spec: {
          id: `repair-${failedCheck}-${attempt}`,
          name: `Repair: ${failedCheck}`,
          specialist: repair.specialist,
          dependsOn: [],
          input: repair.input,
        },
        status: "running",
        attempts: [],
      };
      job.setPlan({
        ...job.plan!,
        taskIds: [...job.plan!.taskIds, repairTask.spec.id],
        order: [...job.plan!.order],
        tasks: [...job.plan!.tasks, repairTask.spec],
      });

      let repairOk = false;
      try {
        const output = await this.runner.run(
          {
            task: repairTask,
            correlation,
            objectives: [job.objective],
            input: repair.input,
            sandbox: this.resolveSandbox(job),
            capabilities: taskCapabilities(repair.specialist),
            policy: this.policy,
          },
          signal,
        );
        repairOk = !output.error;
        await this.events.append({
          type: repairOk ? "repair.completed" : "repair.failed",
          taskId: failedCheck,
          attempt,
          reason: repairOk ? "" : (output.error?.message ?? "failed"),
          success: repairOk,
          tenantId: this.tenantId,
          correlation,
        });
      } catch (err) {
        const classified = classifyError(err, "unknown", correlation);
        await this.events.append({
          type: "repair.failed",
          taskId: failedCheck,
          attempt,
          reason: classified.message,
          tenantId: this.tenantId,
          correlation,
        });
      }

      // Re-verify after repair.
      const reverify = await this.verify(job, correlation, signal);
      if (reverify.passed) {
        return true;
      }
    }

    return false;
  }

  /** Cancel a running job, propagating to the abort controller. */
  async cancel(jobId: string): Promise<void> {
    const controller = this.#abortControllers.get(jobId);
    controller?.abort();
    const job = this.#jobs.get(jobId);
    if (job) {
      job.cancel("Cancelled by operator");
      await this.events.append({
        type: "job.cancelled",
        reason: "Cancelled by operator",
        tenantId: this.tenantId,
        correlation:
          this.#correlation.get(jobId) ?? newCorrelation(this.tenantId, jobId),
      });
    }
  }

  async getJob(jobId: string): Promise<JobSnapshot | undefined> {
    const job = this.#jobs.get(jobId);
    return job ? job.snapshot() : undefined;
  }

  async replay(jobId: string): Promise<readonly IntelligenceEvent[]> {
    return this.events.replay(jobId);
  }

  private makeCallbacks(
    job: JobAggregate,
    correlation: CorrelationId,
  ): SchedulerCallbacks {
    const runner = this.runner;
    return {
      runTask: async (scheduled, taskSignal) => {
        const output = await runner.run(
          {
            task: scheduled.task,
            correlation: { ...correlation, task: scheduled.task.spec.id },
            objectives: [job.objective],
            input: scheduled.task.spec.input,
            sandbox: undefined,
            capabilities: taskCapabilities(scheduled.task.spec.specialist),
            policy: job.policy,
          },
          taskSignal,
        );
        if (output.error) {
          job.recordAttempt(scheduled.task.spec.id, {
            attempt:
              (job.getTask(scheduled.task.spec.id)?.attempts.length ?? 0) + 1,
            startedAt: Date.now(),
            endedAt: Date.now(),
            error: {
              failureClass: output.error.failureClass,
              message: redactSecrets(output.error.message),
              code: output.error.code,
              retryable: output.error.retryable ?? false,
            },
          });
          throw new IntelligenceError(
            output.error.failureClass as FailureClass,
            output.error.message,
            { correlation },
          );
        }
        job.setTaskResult(scheduled.task.spec.id, output.output, output.usage);
        return output;
      },
      onCompleted: async (taskId) => {
        try {
          job.setTaskStatus(taskId, "completed");
        } catch {
          // already terminal
        }
      },
      onFailed: async (taskId, error) => {
        try {
          job.setTaskStatus(taskId, "failed");
        } catch {
          // already terminal
        }
        const task = job.getTask(taskId);
        if (task) {
          job.recordAttempt(taskId, {
            attempt: task.attempts.length + 1,
            startedAt: Date.now(),
            endedAt: Date.now(),
            error: {
              failureClass: error.failureClass,
              message: redactSecrets(error.message),
              code: error.metadata.code,
              retryable: error.metadata.retryable ?? false,
            },
          });
        }
      },
    };
  }
}
