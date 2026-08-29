/**
 * Vaulltcore Intelligence — bounded parallel scheduler.
 *
 * Executes ready tasks (those whose dependencies are complete) under
 * concurrency limits derived from the execution policy. Provides:
 *  - bounded parallelism (maxParallelism)
 *  - active-agent accounting (maxAgents via BudgetTracker)
 *  - cancellation propagation (AbortSignal)
 *  - failure propagation (a failed task fails its dependents transitively)
 *  - resource budgets (delegated to BudgetTracker)
 *  - duplicate-work prevention (deterministic task ids dedupe in JobAggregate)
 *
 * The scheduler is a generic executor framework: it does NOT know how to run
 * a specialist. That lives in the orchestrator. The scheduler only decides
 * *which* tasks run *when*, and tracks their completion.
 */

import {
  IntelligenceError,
  TimeoutFailure,
  BudgetFailure,
  classifyError,
} from "./errors";
import type { IntelligenceError as IntelligenceErrorType } from "./errors";
import type { JobAggregate, TaskRecord } from "./job-model";
import type { TaskGraph } from "./task-graph";
import type { BudgetTracker } from "./budget";
import type { ExecutionPolicy } from "./policy";
import type { CorrelationId } from "./correlation";

export interface ScheduledTask {
  readonly task: TaskRecord;
  readonly correlation: CorrelationId;
}

export interface SchedulerCallbacks {
  runTask: (task: ScheduledTask, signal: AbortSignal) => Promise<unknown>;
  onCompleted: (taskId: string, output: unknown) => Promise<void> | void;
  onFailed: (
    taskId: string,
    error: IntelligenceErrorType,
  ) => Promise<void> | void;
}

export interface SchedulerResult {
  readonly completed: readonly string[];
  readonly failed: readonly string[];
  readonly cancelled: readonly string[];
  readonly skipped: readonly string[];
  readonly error?: IntelligenceErrorType;
}

export interface SchedulerDeps {
  readonly policy: ExecutionPolicy;
  readonly budget: BudgetTracker;
  readonly log: EventLogger;
}

export interface EventLogger {
  warn(message: string): void;
  error(message: string): void;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const controller = new AbortController();
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  setTimeout(() => controller.abort(), Math.max(1, ms)).unref?.();
  return controller.signal;
}

/**
 * Run the ready set of a task graph under bounded concurrency. Returns when all
 * reachable tasks are terminal or the abort signal fires or a hard
 * budget/timeout is hit.
 *
 * Failure propagation: when a task fails, all transitively-dependent tasks are
 * marked `skipped` because their prerequisite is gone.
 */
export async function scheduleExecution(
  deps: SchedulerDeps,
  job: JobAggregate,
  graph: TaskGraph,
  callbacks: SchedulerCallbacks,
  signal?: AbortSignal,
): Promise<SchedulerResult> {
  if (graph.hasCycle) {
    return {
      completed: [],
      failed: [],
      cancelled: [],
      skipped: [],
      error: new IntelligenceError(
        "planning",
        `Cannot schedule cyclic task graph; cycle: ${(graph.cycle ?? []).join(" → ")}`,
        { correlation: { tenant: job.tenantId, job: job.id } },
      ),
    };
  }

  const completed = new Set<string>();
  const failed = new Set<string>();
  const skipped = new Set<string>();
  const cancelled = new Set<string>();
  const running = new Set<string>();
  const pending = new Set<string>(graph.order);

  if (deps.budget.exhausted) {
    return {
      completed: [],
      failed: [],
      cancelled: [],
      skipped: [],
      error: new BudgetFailure("Budget exhausted before execution", {
        metadata: { code: "budget.exhausted.pre" },
      }),
    };
  }

  const deadline = Date.now() + deps.policy.maxRuntimeMs;

  if (signal?.aborted) {
    return {
      completed: [],
      failed: [],
      cancelled: [],
      skipped: [],
      error: classifyError(
        new DOMException("aborted", "AbortError"),
        "cancellation",
        { tenant: job.tenantId, job: job.id },
      ),
    };
  }

  const onAbort = () => {
    for (const node of graph.nodes) {
      if (
        !completed.has(node.id) &&
        !failed.has(node.id) &&
        !skipped.has(node.id)
      ) {
        cancelled.add(node.id);
        try {
          job.setTaskStatus(node.id, "cancelled");
        } catch {
          // best-effort
        }
      }
    }
  };

  const computeReady = (): string[] => {
    if (signal?.aborted) return [];
    return graph
      .ready(completed)
      .filter((id) => !running.has(id) && pending.has(id));
  };

  /** Cascade-skip all transitively-dependent tasks. */
  const markSkipped = (id: string) => {
    if (skipped.has(id) || completed.has(id) || failed.has(id)) return;
    skipped.add(id);
    pending.delete(id);
    try {
      job.setTaskStatus(id, "skipped");
    } catch {
      // already terminal
    }
    for (const node of graph.nodes) {
      if (node.dependsOn.includes(id)) {
        markSkipped(node.id);
      }
    }
  };

  const markFailed = (id: string) => {
    if (failed.has(id)) return;
    failed.add(id);
    pending.delete(id);
    try {
      job.setTaskStatus(id, "failed");
    } catch {
      // best-effort
    }
    for (const node of graph.nodes) {
      if (node.dependsOn.includes(id)) {
        markSkipped(node.id);
      }
    }
  };

  const inFlight = new Set<Promise<void>>();

  const runOne = (id: string): Promise<void> => {
    const record = job.getTask(id);
    if (!record) {
      running.delete(id);
      deps.budget.releaseAgent();
      return Promise.resolve();
    }

    const base = record.activeCorrelation ?? {
      tenant: job.tenantId,
      job: job.id,
    };
    const correlation: CorrelationId = {
      tenant: base.tenant ?? job.tenantId,
      job: base.job ?? job.id,
      task: id,
      agent: base.agent,
      sandbox: base.sandbox,
      modelCall: base.modelCall,
      toolCall: base.toolCall,
      verification: base.verification,
    };

    pending.delete(id);
    running.add(id);
    try {
      job.setTaskStatus(id, "running");
    } catch {
      // may already be terminal
    }

    const p = (async () => {
      const taskStart = Date.now();
      const taskSignal = withTimeout(
        signal,
        Math.max(1_000, deadline - Date.now()),
      );

      try {
        const taskResult = await callbacks.runTask(
          { task: record, correlation },
          taskSignal,
        );
        const elapsed = Date.now() - taskStart;
        deps.budget.recordRuntime(elapsed);

        completed.add(id);
        try {
          job.setTaskStatus(id, "completed");
        } catch {
          // already terminal
        }
        try {
          await callbacks.onCompleted(id, taskResult);
        } catch (err) {
          deps.log.warn(
            `onCompleted hook threw for task ${id}: ${String(err)}`,
          );
        }
      } catch (err) {
        const classified = classifyError(err, "unknown", correlation);
        markFailed(id);
        try {
          await callbacks.onFailed(id, classified);
        } catch (hookErr) {
          deps.log.warn(
            `onFailed hook threw for task ${id}: ${String(hookErr)}`,
          );
        }
      } finally {
        running.delete(id);
        deps.budget.releaseAgent();
      }
    })();

    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };

  const schedule = () => {
    if (signal?.aborted || pending.size === 0) return;
    const ready = computeReady();
    for (const id of ready) {
      if (running.size >= deps.policy.maxParallelism) break;
      const breach = deps.budget.acquireAgent();
      if (breach) {
        deps.log.warn(
          `Concurrency ceiling reached (${breach.consumed}/${breach.limit}); queuing`,
        );
        break;
      }
      runOne(id);
    }
  };

  // Initial scheduling pass.
  schedule();

  // Drain loop: wait for in-flight tasks, then schedule more.
  while (inFlight.size > 0) {
    if (signal?.aborted) {
      onAbort();
      break;
    }
    if (Date.now() > deadline) break;
    await Promise.race(inFlight);
    schedule();
    if (inFlight.size === 0) break;
  }

  // Handle abort / deadline after drain.
  if (signal?.aborted) {
    onAbort();
  } else if (Date.now() > deadline && inFlight.size > 0) {
    for (const nid of pending) markSkipped(nid);
    for (const nid of running) {
      cancelled.add(nid);
      try {
        job.setTaskStatus(nid, "cancelled");
      } catch {
        // best-effort
      }
    }
    running.clear();
    pending.clear();
  }

  signal?.removeEventListener("abort", onAbort);

  if (signal?.aborted) {
    return {
      completed: [...completed],
      failed: [...failed],
      cancelled: [...cancelled],
      skipped: [...skipped],
      error: classifyError(
        new DOMException("aborted", "AbortError"),
        "cancellation",
        { tenant: job.tenantId, job: job.id },
      ),
    };
  }

  if (Date.now() > deadline && (running.size > 0 || pending.size > 0)) {
    return {
      completed: [...completed],
      failed: [...failed],
      cancelled: [...cancelled],
      skipped: [...skipped],
      error: new TimeoutFailure("Job exceeded maximum runtime", {
        metadata: { code: "job.timeout" },
      }),
    };
  }

  return {
    completed: [...completed],
    failed: [...failed],
    cancelled: [...cancelled],
    skipped: [...skipped],
  };
}
