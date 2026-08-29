/**
 * Vaulltcore Durable Execution — DAG planning.
 *
 * Phase 4.1 closes F-7 (multi-step DAG execution). The durable workflow layer
 * must be able to plan more than a single "main" task: it must accept a
 * directed acyclic graph of tasks with explicit dependencies and let the
 * scheduler determine, for each poll: which tasks are runnable (dependencies
 * satisfied), which are parallel, which are blocked, and which have failed
 * dependencies.
 *
 * This module defines the provider-neutral `DagSpec` and a pure `planDag`
 * that stamps durable ids onto each node. The runtime persists the resulting
 * tasks; the scheduler (`releaseSteps`) is the sole authority on *when* each
 * task's step is released, using dependency satisfaction as the gating rule.
 */

import {
  createDurableTaskId,
  createDurableStepId,
  type DurableJobId,
  type DurableRunId,
  type DurableTaskId,
  type TenantId,
} from "./identity";
import type { DurableTaskSpec, Task } from "./model";

export interface DagNodeSpec {
  /** Stable node name used for dependency references (not the durable id). */
  readonly name: string;
  readonly specialist: string;
  readonly dependsOn: readonly string[];
  readonly input: unknown;
}

export interface DagSpec {
  readonly nodes: readonly DagNodeSpec[];
}

export interface PlannedTask {
  readonly task: Task;
  readonly spec: DurableTaskSpec;
}

const VALID_DAG_NODES = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validate a DAG spec. Returns a list of reasons (empty = valid). Detects:
 *  - malformed node names,
 *  - duplicate node names,
 *  - dependencies on unknown nodes,
 *  - self-dependencies,
 *  - cycle presence (via topological sort).
 */
export function validateDag(spec: DagSpec): readonly string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  for (const node of spec.nodes) {
    if (!VALID_DAG_NODES.test(node.name)) {
      errors.push(`invalid node name: ${node.name}`);
      continue;
    }
    if (names.has(node.name)) {
      errors.push(`duplicate node name: ${node.name}`);
    }
    names.add(node.name);
  }
  const byName = new Map(spec.nodes.map((n) => [n.name, n]));
  for (const node of spec.nodes) {
    for (const dep of node.dependsOn) {
      if (dep === node.name) errors.push(`self-dependency: ${node.name}`);
      if (!byName.has(dep))
        errors.push(`unknown dependency ${dep} in ${node.name}`);
    }
  }
  if (errors.length === 0) {
    const cycle = findCycle(spec);
    if (cycle) errors.push(`cycle detected: ${cycle.join(" -> ")}`);
  }
  return errors;
}

function findCycle(spec: DagSpec): string[] | null {
  const byName = new Map(spec.nodes.map((n) => [n.name, n]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of spec.nodes) color.set(n.name, WHITE);

  // Proper DFS with coloring to detect a back-edge (cycle).
  const dfs = (name: string, path: string[]): string[] | null => {
    color.set(name, GRAY);
    path.push(name);
    const node = byName.get(name);
    if (!node) return null;
    for (const dep of node.dependsOn) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) return [...path, dep];
      if (c === WHITE) {
        const found = dfs(dep, path);
        if (found) return found;
      }
    }
    path.pop();
    color.set(name, BLACK);
    return null;
  };

  for (const n of spec.nodes) {
    if ((color.get(n.name) ?? WHITE) === WHITE) {
      const found = dfs(n.name, []);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Plan a DAG into durable tasks for a run. Each node becomes one durable task
 * with a deterministic id derived from (jobId, name). The initial step (attempt
 * 1) is created for each task. Returns the planned tasks keyed by node name.
 */
export async function planDag(
  spec: DagSpec,
  jobId: DurableJobId,
  runId: DurableRunId,
  tenantId: TenantId,
  createdAt: number,
  saveTask: (id: DurableTaskId, task: Task) => Promise<boolean>,
  saveStep: (
    step: import("./model").Step,
    expectedVersion: number,
  ) => Promise<boolean>,
  taskDeadlineAt?: number,
): Promise<readonly PlannedTask[]> {
  const planned: PlannedTask[] = [];
  for (const node of spec.nodes) {
    const taskId = createDurableTaskId(jobId, node.name);
    const taskSpec: DurableTaskSpec = {
      id: taskId,
      name: node.name,
      specialist: node.specialist,
      dependsOn: node.dependsOn,
      input: node.input,
    };
    const task: Task = {
      id: taskId,
      runId,
      jobId,
      spec: taskSpec,
      status: "queued",
      attempt: 1,
      completedSteps: [],
      version: 0,
      startedAt: createdAt,
      deadlineAt: taskDeadlineAt,
    };
    await saveTask(taskId, task);

    const stepId = createDurableStepId(taskId, 1);
    const step: import("./model").Step = {
      id: stepId,
      runId,
      taskId,
      tenantId,
      attempt: 1,
      taskIdRef: taskSpec.id,
      status: "queued",
      createdAt,
      version: 0,
      deadlineAt: taskDeadlineAt,
    };
    await saveStep(step, 0);

    const updatedTask: Task = {
      ...task,
      currentStepId: stepId,
      status: "queued",
      version: 1,
    };
    await saveTask(taskId, updatedTask);
    planned.push({ task: updatedTask, spec: taskSpec });
  }
  return planned;
}
