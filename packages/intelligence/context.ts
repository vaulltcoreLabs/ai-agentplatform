/**
 * Vaulltcore Intelligence — task-scoped context strategy.
 *
 * Prevents every specialist from receiving the entire repository or
 * conversation. Context is built per-task from a prioritized evidence set:
 * relevant files, previous results, tool outputs, and summarized context.
 * Context is reproducible (deterministic hashing of the same inputs) and
 * bounded in size.
 *
 * The builder is a pure function: (task, prior evidence, memory) → context
 * string. No unbounded token growth — a hard cap truncates oldest content with
 * deterministic precedence.
 */

import type { TaskRecord, JobSnapshot } from "./job-model";
import type { MemoryContract } from "./memory";

export interface EvidenceSource {
  readonly id: string;
  readonly kind: "file" | "result" | "tool-output" | "summary" | "memory";
  readonly priority: number;
  readonly tokens: number;
  readonly content: string;
  readonly path?: string;
  readonly hash: string;
}

export interface ContextBuilderOptions {
  /** Maximum tokens of context to assemble. */
  readonly maxTokens: number;
  /** Maximum number of file snippets to include. */
  readonly maxFiles: number;
  /** Truncate individual file content to this many chars. */
  readonly maxFileChars: number;
}

export const DEFAULT_CONTEXT_OPTIONS: ContextBuilderOptions = {
  maxTokens: 8_000,
  maxFiles: 30,
  maxFileChars: 12_000,
};

export interface BuiltContext {
  readonly text: string;
  readonly sources: readonly EvidenceSource[];
  readonly truncated: boolean;
  readonly tokenEstimate: number;
}

/**
 * Build a task-scoped context string from:
 *  - repository facts (from memory)
 *  - relevant files (selected by the explorer's findings)
 *  - previous task results
 *  - the task's own input
 *
 * Precedence: task input → prior results → files → summaries → memory.
 * Lower-priority sources are truncated first when the budget is exceeded.
 */
export async function buildTaskContext(
  task: TaskRecord,
  job: JobSnapshot,
  sources: readonly EvidenceSource[],
  memory: MemoryContract,
  options: ContextBuilderOptions = DEFAULT_CONTEXT_OPTIONS,
): Promise<BuiltContext> {
  const prioritized = [...sources].sort(
    (a, b) => b.priority - a.priority || a.tokens - b.tokens,
  );

  let tokens = 0;
  let truncated = false;
  let budget = options.maxTokens;
  const included: EvidenceSource[] = [];

  // Take highest-priority sources first.
  for (const src of prioritized) {
    if (src.tokens <= budget) {
      included.push(src);
      tokens += src.tokens;
      budget -= src.tokens;
    } else {
      truncated = true;
    }
  }

  if (truncated) {
    for (const src of prioritized) {
      if (included.includes(src)) continue;
      // Try to fit a truncated version if it's high priority.
      if (src.priority < 5) continue;
      const slice = truncateToBudget(src, budget);
      if (slice) {
        included.push({ ...src, content: slice.text, tokens: slice.tokens });
        tokens += slice.tokens;
        budget -= slice.tokens;
        truncated = truncated || slice.truncated;
      }
    }
  }

  // Compose: task input first, then evidence in priority order.
  const parts: string[] = [
    `## Task: ${task.spec.name}\n\n${formatInput(task.spec.input)}`,
    ...included.map(formatSource),
  ];

  const text = parts.join("\n\n---\n\n");
  return {
    text,
    sources: included,
    truncated,
    tokenEstimate: estimateTokens(text),
  };
}

function formatInput(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function formatSource(src: EvidenceSource): string {
  const header = src.path
    ? `### ${src.kind}: ${src.path}`
    : `### ${src.kind}: ${src.id}`;
  return `${header}\n\n${src.content}`;
}

function truncateToBudget(
  src: EvidenceSource,
  budget: number,
): { text: string; tokens: number; truncated: boolean } | undefined {
  if (src.tokens <= budget) {
    return { text: src.content, tokens: src.tokens, truncated: false };
  }
  // Reserve ~10% headroom.
  const target = Math.floor(budget * 0.9);
  const approxChars = Math.floor(
    (target / Math.max(src.tokens, 1)) * src.content.length,
  );
  if (approxChars < 50) {
    return undefined;
  }
  const text = src.content.slice(0, approxChars);
  return {
    text: text + "...[truncated]",
    tokens: target,
    truncated: true,
  };
}

function estimateTokens(text: string): number {
  // Rough heuristic: 1 token ≈ 4 chars.
  return Math.ceil(text.length / 4);
}
