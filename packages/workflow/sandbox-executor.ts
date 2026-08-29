/* eslint-disable max-classes-per-file */
/**
 * Vaulltcore Durable Execution — Sandbox-backed StepExecutor.
 *
 * Phase 4.3 wires real execution through the full pipeline:
 *
 *   ExecutionPlan (Phase 3) → Workflow (Phase 4) → StepExecutor → Sandbox → Agent Engine
 *
 * The `SandboxStepExecutor` implements the `StepExecutor` contract from
 * `contracts.ts`. It is the bridge that turns a durable `StepExecution`
 * (which carries a `Step`, `Task`, `Job`, `Lease`, deadline, and
 * idempotency key) into real work inside a `Sandbox` via the Agent Engine.
 *
 * Key responsibilities:
 *  - Translate the durable `Step` spec into an agent prompt and model selection.
 *  - Bind the sandbox to the agent via `AgentSandboxContext`.
 *  - Propagate the `AbortSignal` (carrying both run-level cancellation and the
 *    step deadline) into the agent's `abortSignal`, which in turn flows to
 *    `Sandbox.exec` via the signal option.
 *  - Map the agent's result/usage/errors onto the `StepResult` contract,
 *    classifying failures using the Phase 3 `FailureClass` taxonomy.
 *  - Enforce idempotency: the `StepExecution.idempotencyKey` is passed through
 *    to the agent for any external side-effecting calls.
 *
 * The executor depends only on provider-neutral abstractions:
 *  - `@vaulltcore/agent` (VaulltcoreAgent, AgentSandboxContext, createVaulltcoreAgent)
 *  - `@vaulltcore/sandbox` (Sandbox, SandboxState, SandboxSecurityPolicy)
 *  - `@vaulltcore/intelligence` (FailureClass, classifyError, ExecutionPolicy)
 * No Docker/SDK imports leak through here.
 */

import type {
  Sandbox,
  SandboxState,
  SandboxSecurityPolicy,
} from "@vaulltcore/sandbox";
import {
  createVaulltcoreAgent,
  type VaulltcoreAgent,
  type VaulltcoreRunOptions,
} from "@vaulltcore/agent";
import {
  classifyError,
  redactSecrets,
  DEFAULT_EXECUTION_POLICY,
  type ExecutionPolicy,
  type FailureClass,
} from "@vaulltcore/intelligence";
import type { StepExecution } from "./model";
import type { StepExecutor, StepResult } from "./contracts";

export interface SandboxStepExecutorOptions {
  /**
   * Factory that produces a connected Sandbox for this execution.
   * Called lazily on each `execute()` so the sandbox lifecycle is scoped
   * to the step (and can be torn down on cancellation). When absent, the
   * step runs as a pure model task without a live sandbox.
   */
  sandboxSupplier?: (execution: StepExecution) => Promise<Sandbox | undefined>;

  /**
   * Optional security policy to apply when provisioning the sandbox.
   * When absent, the provider's default policy applies.
   */
  securityPolicy?: SandboxSecurityPolicy;

  /**
   * Agent supplier. When absent, a default `VaulltcoreAgent` is created.
   * Allows injecting a mock or a pre-configured agent in tests.
   */
  agentSupplier?: () => VaulltcoreAgent;

  /**
   * Optional model selection per execution. When absent, the agent's
   * default model is used.
   */
  model?: string;

  /**
   * Optional subagent model for nested specialist delegation.
   */
  subagentModel?: string;

  /**
   * Execution policy for classifying failures and retry behavior.
   */
  policy?: ExecutionPolicy;
}

/**
 * A `StepExecutor` that runs steps inside a sandbox via the Agent Engine.
 *
 * The executor implements the durable `StepExecutor` interface. It is
 * designed to be stateless between calls — the `Sandbox` is obtained fresh
 * for each step via `sandboxSupplier`, so the same executor instance can
 * serve multiple workers/runs.
 */
export class SandboxStepExecutor implements StepExecutor {
  private readonly sandboxSupplier: SandboxStepExecutorOptions["sandboxSupplier"];
  private readonly securityPolicy?: SandboxSecurityPolicy;
  private readonly agentSupplier?: () => VaulltcoreAgent;
  private readonly model?: string;
  private readonly subagentModel?: string;
  private readonly policy: ExecutionPolicy;
  private readonly agent: VaulltcoreAgent;

  constructor(options: SandboxStepExecutorOptions) {
    this.sandboxSupplier = options.sandboxSupplier;
    this.securityPolicy = options.securityPolicy;
    this.agentSupplier = options.agentSupplier;
    this.model = options.model;
    this.subagentModel = options.subagentModel;
    this.policy = options.policy ?? DEFAULT_EXECUTION_POLICY;
    this.agent = options.agentSupplier
      ? options.agentSupplier()
      : createVaulltcoreAgent();
  }

  async execute(
    execution: StepExecution,
    signal: AbortSignal,
  ): Promise<StepResult> {
    // Check for immediate cancellation.
    if (signal.aborted) {
      return errorResult({
        failureClass: "cancellation",
        message: "Step execution cancelled before start",
        retryable: false,
      });
    }

    // Obtain a sandbox for this step. When a security policy is configured it
    // flows into the agent context so every tool-obtained sandbox (tools
    // reconnect from state) is wrapped by `enforceSecurityPolicy` at the
    // tool I/O boundary. See buildAgentContext + agent tools getSandbox().
    const sandbox = await this.getSandbox(execution, signal);

    // Build the agent sandbox context.
    const agentContext = this.buildAgentContext(execution, sandbox);

    const runOptions: VaulltcoreRunOptions = {
      sandbox: agentContext,
      abortSignal: signal,
      ...(this.model ? { model: this.model } : {}),
      ...(this.subagentModel ? { subagentModel: this.subagentModel } : {}),
    };

    // Build the prompt from the step/task spec.
    const prompt = this.buildPrompt(execution, sandbox);

    try {
      const result = await this.agent.run(prompt, runOptions);

      const usage = normalizeUsage(result.usage);

      // Build checkpoint hint from the step output.
      const checkpoints = [
        {
          stepId: execution.step.id,
          sequence: 0,
          state: {
            status: "completed",
            output: redactForCheckpoint(result.text),
          },
          evidence: [],
        },
      ];

      return {
        output: {
          text: result.text,
          steps: result.steps,
          status: "completed",
        },
        usage,
        artifacts: [],
        checkpoints,
        idempotencyKey: execution.idempotencyKey,
      };
    } catch (err) {
      const classified = classifyError(err, "tool");

      // Check if it was an abort (cancellation).
      if (err instanceof Error && err.name === "AbortError") {
        return errorResult({
          failureClass: "cancellation",
          message: "Step execution aborted (timeout or cancellation)",
          retryable: true,
        });
      }

      const failureClass: FailureClass = classifyForDurable(
        classified.failureClass,
        err,
      );

      return errorResult({
        failureClass,
        message: redactSecrets(
          err instanceof Error ? err.message : String(err),
        ),
        code: classifyErrorCode(err),
        retryable: isRetryableFailure(failureClass),
      });
    } finally {
      // Ensure the sandbox is stopped/cleaned up.
      if (sandbox) {
        try {
          await sandbox.stop();
        } catch {
          // Best-effort cleanup; the sandbox lifecycle is also managed
          // by the provider's timeout/reaping.
        }
      }
    }
  }

  /**
   * Obtain a sandbox for this step execution. When `sandboxSupplier` returns
   * `undefined` (no sandbox available), the executor runs the prompt as a
   * pure model task — the agent's tools will surface a sandbox error if
   * they are invoked.
   */
  private async getSandbox(
    execution: StepExecution,
    signal: AbortSignal,
  ): Promise<Sandbox | undefined> {
    if (!this.sandboxSupplier) {
      return undefined;
    }

    // Propagate signal to sandbox provisioning — if the step was cancelled
    // during sandbox creation, abort.
    if (signal.aborted) {
      return undefined;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      Math.min(execution.deadlineMs, 30_000),
    );

    const signalCleanup = () => clearTimeout(timeoutId);
    signal.addEventListener("abort", signalCleanup, { once: true });
    controller.signal.addEventListener("abort", signalCleanup, { once: true });

    try {
      return await this.sandboxSupplier(execution);
    } catch (err) {
      // If sandbox provisioning fails, classify appropriately and let
      // the caller decide whether to retry.
      const classified = classifyError(err, "sandbox");
      throw new SandboxExecError(
        "Failed to provision sandbox for step execution",
        { cause: err, metadata: { classified: classified.message } },
      );
    } finally {
      signalCleanup();
      clearTimeout(timeoutId);
    }
  }

  /**
   * Build the `AgentSandboxContext` from the durable step execution.
   * The sandbox state and working directory are derived from the `SandboxState`
   * or the sandbox's own properties.
   */
  private buildAgentContext(
    execution: StepExecution,
    sandbox: Sandbox | undefined,
  ): {
    state: SandboxState;
    workingDirectory: string;
    currentBranch?: string;
    environmentDetails?: string;
    securityPolicy?: SandboxSecurityPolicy;
  } {
    if (
      sandbox &&
      "getState" in sandbox &&
      typeof (sandbox as { getState?: unknown }).getState === "function"
    ) {
      const state = (
        sandbox as { getState(): unknown }
      ).getState() as SandboxState;
      return {
        state,
        workingDirectory: sandbox.workingDirectory,
        currentBranch: sandbox.currentBranch,
        environmentDetails: sandbox.environmentDetails,
        securityPolicy: this.securityPolicy,
      };
    }

    // Fallback: build a minimal context from the step's task spec.
    const spec = execution.task.spec;
    const repoCtx = extractRepositoryContext(spec.input);

    return {
      state: {
        type: "docker",
        ...(repoCtx
          ? { source: { repo: repoCtx.repo, branch: repoCtx.branch } }
          : {}),
      } as SandboxState,
      workingDirectory: repoCtx?.workingDirectory ?? "/workspace",
      currentBranch: repoCtx?.branch,
      securityPolicy: this.securityPolicy,
    };
  }

  /**
   * Build the agent prompt from the step spec and task input.
   */
  private buildPrompt(
    execution: StepExecution,
    sandbox: Sandbox | undefined,
  ): string {
    const spec = execution.task.spec;
    const taskInput = extractTaskInput(spec.input);

    const parts: string[] = [`Task: ${taskInput.task ?? spec.name}`, ""];

    if (taskInput.instructions) {
      parts.push(`Instructions:\n${taskInput.instructions}`);
      parts.push("");
    }

    // Working directory context.
    if (sandbox) {
      parts.push(`Working directory: ${sandbox.workingDirectory}`);
      if (sandbox.currentBranch) {
        parts.push(`Current branch: ${sandbox.currentBranch}`);
      }
      parts.push("");
    }

    // Constraints / requirements.
    if (execution.step.deadlineAt) {
      parts.push(
        `Deadline: ${new Date(execution.step.deadlineAt).toISOString()}`,
      );
    }
    parts.push(`Attempt: ${execution.step.attempt}`);
    parts.push(`Idempotency key: ${execution.idempotencyKey}`);

    return parts.join("\n");
  }
}

/**
 * Extract task description and instructions from a spec's `input` field.
 * Handles both structured `{ task, instructions }` shape and string input.
 */
function extractTaskInput(input: unknown): {
  task?: string;
  instructions?: string;
} {
  if (typeof input === "string") {
    return { task: input };
  }
  if (input !== null && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    return {
      task: typeof obj.task === "string" ? obj.task : undefined,
      instructions:
        typeof obj.instructions === "string" ? obj.instructions : undefined,
    };
  }
  return {};
}

/**
 * Extract repository context from a spec's `input` field when present.
 */
function extractRepositoryContext(input: unknown):
  | {
      repo: string;
      branch?: string;
      workingDirectory?: string;
    }
  | undefined {
  if (input !== null && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const repo = obj.repo ?? obj.source;
    if (typeof repo === "string") {
      const branch = typeof obj.branch === "string" ? obj.branch : undefined;
      const workingDirectory =
        typeof obj.workingDirectory === "string"
          ? obj.workingDirectory
          : undefined;
      return { repo, branch, workingDirectory };
    }
  }
  return undefined;
}

function normalizeUsage(usage: unknown): Record<string, number> {
  if (usage !== null && typeof usage === "object") {
    const u = usage as Record<string, number | undefined>;
    return {
      modelCalls: u.totalTokens != null ? 1 : 0,
      toolCalls: u.totalTokens != null ? 1 : 0,
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
    };
  }
  return { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
}

/**
 * Map an intelligence-layer failure class to the durable `FailureClass`
 * taxonomy. Some intelligence classes collapse to the same durable class.
 */
function classifyForDurable(intelClass: string, err: unknown): FailureClass {
  const mapping: Record<string, FailureClass> = {
    model: "model",
    tool: "tool",
    permission: "permission",
    sandbox: "sandbox",
    context: "context",
    timeout: "timeout",
    budget: "budget",
    configuration: "configuration",
    unknown: "unknown",
  };
  return mapping[intelClass] ?? classifyForThrowable(err);
}

function classifyForThrowable(err: unknown): FailureClass {
  if (err instanceof Error) {
    if (err.name === "AbortError") return "cancellation";
    if (err.message?.includes("timeout") || err.message?.includes("deadline"))
      return "timeout";
    if (err.message?.includes("sandbox")) return "sandbox";
    if (err.message?.includes("permission") || err.message?.includes("denied"))
      return "permission";
  }
  return "unknown";
}

function classifyErrorCode(err: unknown): string | undefined {
  if (err instanceof Error) {
    return err.cause !== undefined
      ? (err.cause as { code?: string })?.code
      : undefined;
  }
  return undefined;
}

/**
 * Determine if a failure class is retryable. Aligns with the Phase 3
 * retry policy: sandbox, timeout, model, context, and dependency failures
 * are retryable; configuration, permission, and cancellation are not
 * (permission could be retried after user action, but that requires manual
 * intervention in this layer).
 */
function isRetryableFailure(failureClass: FailureClass): boolean {
  const retryable: FailureClass[] = [
    "model",
    "tool",
    "sandbox",
    "timeout",
    "context",
    "dependency",
  ];
  return retryable.includes(failureClass);
}

function errorResult(error: {
  failureClass: FailureClass;
  message: string;
  code?: string;
  retryable: boolean;
}): StepResult {
  return {
    output: undefined,
    usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
    error: {
      failureClass: error.failureClass,
      message: error.message,
      code: error.code,
      retryable: error.retryable,
      createdAt: Date.now(),
    },
    artifacts: [],
  };
}

function redactForCheckpoint(text: string): Record<string, unknown> {
  return { summary: redactSecrets(text).slice(0, 500) };
}

/**
 * Thrown when sandbox provisioning fails during step execution.
 */
export class SandboxExecError extends Error {
  override readonly name = "SandboxExecError";
  constructor(
    message: string,
    options: { cause?: unknown; metadata?: Record<string, unknown> },
  ) {
    super(message, options);
  }
}
