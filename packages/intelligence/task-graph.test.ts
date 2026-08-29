import { describe, expect, it } from "bun:test";
import {
  buildTaskGraph,
  GraphValidationError,
  validateCompleted,
} from "./task-graph";
import type { TaskSpec } from "./job-model";

function makeSpec(id: string, dependsOn: string[] = []): TaskSpec {
  return {
    id,
    name: `task ${id}`,
    specialist: "explorer",
    dependsOn,
    input: { task: id },
  };
}

describe("task-graph", () => {
  it("builds a linear graph and produces topological order", () => {
    const specs = [makeSpec("a"), makeSpec("b", ["a"]), makeSpec("c", ["b"])];
    const graph = buildTaskGraph(specs);
    expect(graph.order).toEqual(["a", "b", "c"]);
    expect(graph.roots).toEqual(["a"]);
    expect(graph.hasCycle).toBe(false);
  });

  it("ready returns tasks whose deps are complete", () => {
    const graph = buildTaskGraph([
      makeSpec("a"),
      makeSpec("b", ["a"]),
      makeSpec("c", ["a"]),
      makeSpec("d", ["b", "c"]),
    ]);
    expect(graph.ready(new Set())).toEqual(["a"]);
    expect(graph.ready(new Set(["a"]))).toEqual(["b", "c"]);
    expect(graph.ready(new Set(["a", "b", "c"]))).toEqual(["d"]);
  });

  it("isComplete returns true only when all done", () => {
    const graph = buildTaskGraph([makeSpec("a"), makeSpec("b", ["a"])]);
    expect(graph.isComplete(new Set())).toBe(false);
    expect(graph.isComplete(new Set(["a"]))).toBe(false);
    expect(graph.isComplete(new Set(["a", "b"]))).toBe(true);
  });

  it("detects cycles", () => {
    const specs = [
      makeSpec("a", ["c"]),
      makeSpec("b", ["a"]),
      makeSpec("c", ["b"]),
    ];
    const graph = buildTaskGraph(specs);
    expect(graph.hasCycle).toBe(true);
    expect(graph.cycle).toBeDefined();
    expect(graph.cycle!.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects unknown dependencies", () => {
    const specs = [makeSpec("a", ["missing"])];
    expect(() => buildTaskGraph(specs)).toThrow(GraphValidationError);
  });

  it("deduplicates identical task ids", () => {
    const specs = [makeSpec("a"), makeSpec("a"), makeSpec("a", ["a"])];
    const graph = buildTaskGraph(specs);
    expect(graph.nodes.length).toBe(1);
  });

  it("deduplicates dependency edges", () => {
    const specs = [makeSpec("a"), makeSpec("b", ["a", "a"])];
    const graph = buildTaskGraph(specs);
    const node = graph.nodes.find((n) => n.id === "b")!;
    expect(node.dependsOn.length).toBe(1);
  });

  it("roots are nodes with no dependencies", () => {
    const graph = buildTaskGraph([makeSpec("a"), makeSpec("b", ["a"])]);
    expect(graph.roots).toEqual(["a"]);
  });

  it("validateCompleted rejects inconsistent state", () => {
    const graph = buildTaskGraph([makeSpec("a"), makeSpec("b", ["a"])]);
    expect(() => validateCompleted(graph, new Set(["b"]))).toThrow(
      GraphValidationError,
    );
    validateCompleted(graph, new Set(["a", "b"]));
  });

  it("empty graph produces empty order", () => {
    const graph = buildTaskGraph([]);
    expect(graph.order).toEqual([]);
    expect(graph.nodes).toEqual([]);
  });

  it("diamond dependency resolves correctly", () => {
    const graph = buildTaskGraph([
      makeSpec("root"),
      makeSpec("left", ["root"]),
      makeSpec("right", ["root"]),
      makeSpec("sink", ["left", "right"]),
    ]);
    expect(graph.hasCycle).toBe(false);
    expect(graph.order[0]).toBe("root");
    expect(graph.order[graph.order.length - 1]).toBe("sink");
    expect(graph.ready(new Set())).toEqual(["root"]);
    expect(graph.ready(new Set(["root", "left", "right"]))).toEqual(["sink"]);
  });
});
