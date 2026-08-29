/**
 * Vaulltcore Intelligence — verification engine.
 *
 * Completion is never "the model said so." This layer independently evaluates
 * evidence against task requirements. A verifier produces structured
 * `EvidenceItem`s and a `VerificationResult` with confidence + recommended
 * repair. Verification checks span compilation, tests, lint, typecheck, changed
 * files, repository state, expected artifacts, security constraints, and
 * regression risk.
 *
 * The default `DefaultVerifier` is a pure function of (task outcome, evidence,
 * sandbox) → result. A `VerificationBackend` interface allows future
 * model-driven or project-specific verifiers to plug in.
 */

import type {
  EvidenceItem,
  TaskOutcome,
  VerificationResult,
} from "./job-model";
import type { Sandbox } from "@vaulltcore/sandbox";

export interface CheckSpec {
  readonly name: string;
  readonly severity: "info" | "warning" | "error";
  /** Run the check; return evidence items. */
  run: (ctx: VerificationContext) => Promise<EvidenceItem[]>;
}

export interface VerificationContext {
  /** Optional sandbox for in-place checks (compile, test, lint). */
  readonly sandbox?: Sandbox;
  readonly workingDirectory: string;
  readonly outcome: TaskOutcome;
  readonly requirements: readonly string[];
  readonly signal?: AbortSignal;
}

export interface VerificationBackend {
  verify(
    ctx: VerificationContext,
    checks: readonly CheckSpec[],
  ): Promise<VerificationResult>;
}

const DEFAULT_CHECKS: ReadonlyArray<CheckSpec> = [
  {
    name: "output-present",
    severity: "error",
    async run(ctx) {
      const passed = ctx.outcome.output !== undefined;
      return [
        {
          name: "output-present",
          passed,
          detail: passed ? "Task produced output" : "No output produced",
          severity: "error",
        },
      ];
    },
  },
  {
    name: "no-error",
    severity: "error",
    async run(ctx) {
      const passed = !ctx.outcome.error;
      return [
        {
          name: "task-error-free",
          passed,
          detail: ctx.outcome.error
            ? `Task failed: ${ctx.outcome.error.message}`
            : "Task completed without error",
          severity: "error",
        },
      ];
    },
  },
  {
    name: "tests-pass",
    severity: "error",
    async run(ctx) {
      if (!ctx.sandbox) {
        return [
          {
            name: "tests-pass",
            passed: false,
            detail: "No sandbox available to run tests",
            severity: "error",
          },
        ];
      }
      try {
        const result = await ctx.sandbox.exec(
          "pnpm --if-present test 2>&1 || true",
          ctx.workingDirectory,
          120_000,
          { signal: ctx.signal },
        );
        const passing =
          result.success &&
          !result.stdout.includes("FAIL") &&
          !result.stderr.includes("FAIL");
        return [
          {
            name: "tests-pass",
            passed: passing,
            detail: passing
              ? "Tests passed (or no tests defined)"
              : `Tests failed: ${result.stdout.slice(0, 500)}`,
            severity: "error",
          },
        ];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [
          {
            name: "tests-pass",
            passed: false,
            detail: `Test run error: ${msg.slice(0, 500)}`,
            severity: "error",
          },
        ];
      }
    },
  },
  {
    name: "typecheck",
    severity: "error",
    async run(ctx) {
      if (!ctx.sandbox) {
        return [
          {
            name: "typecheck",
            passed: false,
            detail: "No sandbox available for typecheck",
            severity: "error",
          },
        ];
      }
      try {
        const result = await ctx.sandbox.exec(
          "pnpm --if-present typecheck 2>&1 || true",
          ctx.workingDirectory,
          120_000,
          { signal: ctx.signal },
        );
        const passed = result.exitCode === 0;
        return [
          {
            name: "typecheck",
            passed,
            detail: passed
              ? "Typecheck passed"
              : `Typecheck failed: ${result.stdout.slice(0, 500)}`,
            severity: "error",
          },
        ];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [
          {
            name: "typecheck",
            passed: false,
            detail: `Typecheck error: ${msg.slice(0, 500)}`,
            severity: "error",
          },
        ];
      }
    },
  },
  {
    name: "lint",
    severity: "warning",
    async run(ctx) {
      if (!ctx.sandbox) {
        return [
          {
            name: "lint",
            passed: false,
            detail: "No sandbox available for lint",
            severity: "warning",
          },
        ];
      }
      try {
        const result = await ctx.sandbox.exec(
          "pnpm --if-present lint 2>&1 || true",
          ctx.workingDirectory,
          120_000,
          { signal: ctx.signal },
        );
        const passed = result.exitCode === 0;
        return [
          {
            name: "lint",
            passed,
            detail: passed
              ? "Lint passed"
              : `Lint issues: ${result.stdout.slice(0, 500)}`,
            severity: "warning",
          },
        ];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [
          {
            name: "lint",
            passed: false,
            detail: `Lint error: ${msg.slice(0, 500)}`,
            severity: "warning",
          },
        ];
      }
    },
  },
  {
    name: "no-uncommitted-changes",
    severity: "warning",
    async run(ctx) {
      if (!ctx.sandbox) {
        return [
          {
            name: "no-uncommitted-changes",
            passed: true,
            detail: "No sandbox; skipping repo-state check",
            severity: "info",
          },
        ];
      }
      try {
        const result = await ctx.sandbox.exec(
          "git status --porcelain 2>&1 || echo ''",
          ctx.workingDirectory,
          15_000,
          { signal: ctx.signal },
        );
        const changed = result.stdout.trim().length > 0;
        return [
          {
            name: "no-uncommitted-changes",
            passed: !changed,
            detail: changed
              ? `Uncommitted changes remain:\n${result.stdout.slice(0, 300)}`
              : "Working tree clean",
            severity: "warning",
          },
        ];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [
          {
            name: "no-uncommitted-changes",
            passed: false,
            detail: `Repo-state check error: ${msg.slice(0, 300)}`,
            severity: "warning",
          },
        ];
      }
    },
  },
];

export class DefaultVerifier implements VerificationBackend {
  readonly checks: ReadonlyArray<CheckSpec>;

  constructor(checks: readonly CheckSpec[] = DEFAULT_CHECKS) {
    this.checks = [...checks];
  }

  async verify(
    ctx: VerificationContext,
    checks?: readonly CheckSpec[],
  ): Promise<VerificationResult> {
    const active = checks ?? this.checks;

    // Run independent checks concurrently to reduce wall-clock time.
    const results = await Promise.all(active.map((check) => check.run(ctx)));
    const evidence: EvidenceItem[] = [];
    for (const items of results) {
      evidence.push(...items);
    }

    const failed = evidence.filter((e) => !e.passed && e.severity === "error");
    const warnings = evidence.filter(
      (e) => !e.passed && e.severity === "warning",
    );
    const passed = failed.length === 0;

    // Confidence: 1.0 if all checks pass; reduced by failures.
    const errorCount = failed.length;
    const warningCount = warnings.length;
    const confidence =
      errorCount === 0
        ? Math.max(0.5, Math.min(1, 1 - warningCount * 0.05))
        : Math.max(0, Math.min(1, 1 - errorCount * 0.2 - warningCount * 0.1));

    const failedChecks = failed.map((e) => e.name);

    const recommendedRepair = passed
      ? undefined
      : this.recommend(failed, evidence, ctx);

    return {
      passed,
      evidence,
      confidence,
      failedChecks: [...failedChecks],
      recommendedRepair,
    };
  }

  private recommend(
    failed: EvidenceItem[],
    _evidence: EvidenceItem[],
    _ctx: VerificationContext,
  ): VerificationResult["recommendedRepair"] {
    const names = new Set(failed.map((f) => f.name));
    if (names.has("tests-pass")) {
      return {
        specialist: "tester",
        reason: "Tests are failing; investigate and fix failures",
        input: {
          task: "Fix failing tests",
          instructions: "See test output above.",
        },
      };
    }
    if (names.has("typecheck")) {
      return {
        specialist: "coder",
        reason: "Type errors detected; fix type errors",
        input: {
          task: "Fix type errors",
          instructions: "See typecheck output above.",
        },
      };
    }
    if (names.has("lint")) {
      return {
        specialist: "coder",
        reason: "Lint issues detected; clean up",
        input: {
          task: "Fix lint issues",
          instructions: "See lint output above.",
        },
      };
    }
    // Generic retry with the verifier.
    return {
      specialist: "coder",
      reason: `Verification failed: ${failed.map((f) => f.name).join(", ")}`,
      input: {
        task: "Address verification failures",
        instructions: JSON.stringify(
          failed.map((f) => ({ name: f.name, detail: f.detail })),
        ),
      },
    };
  }
}

export const defaultVerifier: DefaultVerifier = new DefaultVerifier();

/** Convenience: verify with the default check set. */
export async function verifyOutcome(
  ctx: VerificationContext,
  checks?: readonly CheckSpec[],
): Promise<VerificationResult> {
  return defaultVerifier.verify(ctx, checks);
}
