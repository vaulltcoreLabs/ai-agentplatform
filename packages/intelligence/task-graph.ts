/**
 * Vaulltcore Intelligence — task dependency graph (DAG).
 *
 * Given a set of tasks (each with an id and a list of dependencies), this
 * module computes a deterministic topological execution order, detects
 * cycles, and provides ready/remaining queries used by the scheduler.
 *
 * The graph is immutable: construction validates invariants and returns a
 * frozen, read-only `TaskGraph`. Scheduling mutates a separate `GraphScheduler`
 * view.
 */

import type { TaskSpec } from "./job-model";

export interface GraphNode {
  readonly id: string;
  readonly spec: TaskSpec;
  readonly dependsOn: readonly string[];
  readonly dependents: readonly string[];
}

export interface ValidatedTask {
  readonly id: string;
  readonly name: string;
  readonly specialist: string;
  readonly dependsOn: readonly string[];
  readonly input: unknown;
}

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

export interface TaskGraph {
  readonly nodes: ReadonlyArray<ValidatedTask>;
  readonly order: readonly string[];
  readonly roots: readonly string[];
  hasCycle: boolean;
  readonly cycle: readonly string[] | undefined;
  /** Nodes whose dependencies are all satisfied by `completed`. */
  ready(completed: ReadonlySet<string>): readonly string[];
  /** True when every node is in `completed`. */
  isComplete(completed: ReadonlySet<string>): boolean;
}

interface InternalNode {
  id: string;
  name: string;
  specialist: string;
  dependsOn: string[];
  dependents: string[];
  input: unknown;
}

/**
 * Build a validated task dependency graph from task specs. Performs:
 *  - dependency existence validation
 *  - deduplication (duplicate ids collapse to first definition)
 *  - cycle detection with the offending cycle returned
 *  - topological sort (Kahn's algorithm, deterministic tie-break by id)
 */
export function buildTaskGraph(specs: readonly TaskSpec[]): TaskGraph {
  const byId = new Map<string, InternalNode>();

  for (const spec of specs) {
    if (byId.has(spec.id)) {
      // Duplicate task id — collapse to first definition (dedupe).
      continue;
    }
    const node: InternalNode = {
      id: spec.id,
      name: spec.name,
      specialist: spec.specialist,
      dependsOn: [...spec.dependsOn],
      dependents: [],
      input: spec.input,
    };
    byId.set(spec.id, node);
  }

  // Validate dependencies exist.
  for (const node of byId.values()) {
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) {
        throw new GraphValidationError(
          `Task '${node.id}' depends on unknown task '${dep}'`,
        );
      }
    }
  }

  // Build reverse edges.
  for (const node of byId.values()) {
    for (const dep of node.dependsOn) {
      const depNode = byId.get(dep)!;
      depNode.dependents.push(node.id);
    }
  }

  // Deduplicate edges.
  for (const node of byId.values()) {
    node.dependsOn = [...new Set(node.dependsOn)];
    node.dependents = [...new Set(node.dependents)];
  }

  const cycle = detectCycle(byId);
  const hasCycle = cycle !== undefined;

  // Topological sort even when a cycle exists (best-effort); the caller
  // rejects cyclic graphs explicitly.
  const order = topologicalSort(byId);

  const roots = [...byId.values()]
    .filter((n) => n.dependsOn.length === 0)
    .map((n) => n.id)
    .sort();

  const nodes: ValidatedTask[] = [...byId.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      name: n.name,
      specialist: n.specialist,
      dependsOn: [...n.dependsOn],
      input: n.input,
    }));

  return {
    nodes,
    order,
    roots,
    hasCycle,
    cycle,
    ready(completed: ReadonlySet<string>): readonly string[] {
      return nodes
        .filter(
          (n) =>
            !completed.has(n.id) && n.dependsOn.every((d) => completed.has(d)),
        )
        .map((n) => n.id)
        .sort();
    },
    isComplete(completed: ReadonlySet<string>): boolean {
      return nodes.every((n) => completed.has(n.id));
    },
  };
}

function detectCycle(byId: Map<string, InternalNode>): string[] | undefined {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const dfs = (id: string): string[] | undefined => {
    color.set(id, GRAY);
    stack.push(id);
    const node = byId.get(id)!;
    for (const dep of node.dependsOn) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        // Found a back edge → cycle.
        const cycleStart = stack.indexOf(dep);
        return stack.slice(cycleStart);
      }
      if (c === WHITE) {
        const found = dfs(dep);
        if (found) {
          return found;
        }
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return undefined;
  };

  for (const id of byId.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const cycle = dfs(id);
      if (cycle) {
        return cycle;
      }
    }
  }
  return undefined;
}

function topologicalSort(byId: Map<string, InternalNode>): string[] {
  // Kahn's algorithm with deterministic tie-break (sorted by id).
  const inDegree = new Map<string, number>();
  for (const node of byId.values()) {
    inDegree.set(node.id, node.dependsOn.length);
  }

  const ready: string[] = [];
  for (const id of byId.keys()) {
    if ((inDegree.get(id) ?? 0) === 0) {
      ready.push(id);
    }
  }
  ready.sort();

  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    order.push(current);
    const node = byId.get(current)!;
    for (const depId of node.dependents) {
      const deg = (inDegree.get(depId) ?? 0) - 1;
      inDegree.set(depId, deg);
      if (deg === 0) {
        // Insert maintaining sorted order for determinism.
        const idx = ready.findIndex((r) => r > depId);
        if (idx === -1) {
          ready.push(depId);
        } else {
          ready.splice(idx, 0, depId);
        }
      }
    }
  }

  return order;
}

/**
 * Validate that a partially-completed task set is consistent (no completed
 * task depends on an uncompleted one). Useful as an invariant check in tests.
 */
export function validateCompleted(
  graph: TaskGraph,
  completed: ReadonlySet<string>,
): void {
  for (const node of graph.nodes) {
    if (completed.has(node.id)) {
      for (const dep of node.dependsOn) {
        if (!completed.has(dep)) {
          throw new GraphValidationError(
            `Completed task '${node.id}' depends on incomplete task '${dep}'`,
          );
        }
      }
    }
  }
}
