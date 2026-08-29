/**
 * Vaulltcore Intelligence — failure taxonomy.
 *
 * Phase 3 extends the Phase 1 `AgentError` taxonomy with engineering-execution
 * failure classes. Every failure carries a machine-readable `failureClass` and
 * correlation metadata so the repair loop and telemetry can act on it
 * programmatically. Secrets are never exposed in messages (reuses the Phase 1
 * redaction helpers from `@vaulltcore/agent`).
 */

import { redactSecrets, wrapError, type AgentError } from "@vaulltcore/agent";
import type { CorrelationId } from "./correlation";

/* eslint-disable max-classes-per-file */

export type FailureClass =
  | "planning"
  | "model"
  | "tool"
  | "permission"
  | "sandbox"
  | "context"
  | "dependency"
  | "verification"
  | "timeout"
  | "budget"
  | "conflict"
  | "configuration"
  | "cancellation"
  | "unknown";

export interface IntelligenceErrorMetadata {
  /** Stable machine-readable code, e.g. "verification.tests.failed". */
  code?: string;
  /** Correlation context for tracing. No secrets. */
  correlation?: CorrelationId;
  /** Stable failure class. */
  failureClass?: FailureClass;
  /** Whether the failure is transient and worth retrying. */
  retryable?: boolean;
  /** Whether the failure is recoverable via the repair loop. */
  recoverable?: boolean;
  /** Additional non-sensitive diagnostic context. */
  [key: string]: unknown;
}

export class IntelligenceError extends Error {
  readonly failureClass: FailureClass;
  readonly metadata: IntelligenceErrorMetadata;
  readonly correlation?: CorrelationId;
  /** True when produced by tenant/operator cancellation. */
  readonly isCancellation: boolean;
  declare cause?: unknown;

  constructor(
    failureClass: FailureClass,
    message: string,
    options: {
      metadata?: IntelligenceErrorMetadata;
      cause?: unknown;
      isCancellation?: boolean;
      correlation?: CorrelationId;
    } = {},
  ) {
    super(redactSecrets(message));
    this.name = "IntelligenceError";
    this.failureClass = failureClass;
    this.isCancellation = options.isCancellation ?? false;
    this.correlation = options.correlation;
    this.metadata = {
      failureClass,
      correlation: options.correlation,
      ...options.metadata,
    };
    this.cause = options.cause;
  }
}

function makeSubclass(
  failureClass: FailureClass,
  name: string,
  isCancellation = false,
) {
  return class extends IntelligenceError {
    constructor(
      message: string,
      options: {
        metadata?: IntelligenceErrorMetadata;
        cause?: unknown;
        correlation?: CorrelationId;
      } = {},
    ) {
      super(failureClass, message, { ...options, isCancellation });
      this.name = name;
    }
  };
}

export const PlanningFailure = makeSubclass("planning", "PlanningFailure");
export const ModelFailure = makeSubclass("model", "ModelFailure");
export const ToolFailure = makeSubclass("tool", "ToolFailure");
export const PermissionFailure = makeSubclass(
  "permission",
  "PermissionFailure",
);
export const SandboxFailure = makeSubclass("sandbox", "SandboxFailure");
export const ContextFailure = makeSubclass("context", "ContextFailure");
export const DependencyFailure = makeSubclass(
  "dependency",
  "DependencyFailure",
);
export const VerificationFailure = makeSubclass(
  "verification",
  "VerificationFailure",
);
export const TimeoutFailure = makeSubclass("timeout", "TimeoutFailure");
export const BudgetFailure = makeSubclass("budget", "BudgetFailure");
export const ConflictFailure = makeSubclass("conflict", "ConflictFailure");
export const ConfigurationFailure = makeSubclass(
  "configuration",
  "ConfigurationFailure",
);
export const CancellationFailure = makeSubclass(
  "cancellation",
  "CancellationFailure",
  true,
);
export const UnknownFailure = makeSubclass("unknown", "UnknownFailure");

/**
 * Classify an arbitrary thrown value into a structured `IntelligenceError`.
 * Honors existing `AgentError` kinds and abort/cancellation signals, otherwise
 * maps to `UnknownFailure`. No secret content survives classification.
 */
export function classifyError(
  err: unknown,
  fallback: FailureClass = "unknown",
  correlation?: CorrelationId,
): IntelligenceError {
  if (err instanceof IntelligenceError) {
    return err;
  }

  if (err instanceof Error) {
    const isCancellation =
      err.name === "AbortError" ||
      err.name === "CancelledError" ||
      /abort|cancel/i.test(err.message);

    if (isCancellation) {
      return new IntelligenceError("cancellation", err.message, {
        cause: err,
        isCancellation: true,
        correlation,
      });
    }

    // Preserve Phase 1 AgentError classification where possible.
    if (isAgentErrorLike(err)) {
      const kind = err.kind;
      const mapped = agentKindToFailureClass(kind);
      return new IntelligenceError(mapped, err.message, {
        cause: err,
        correlation,
        metadata: {
          code: err.metadata?.code,
          retryable: err.metadata?.retryable,
        },
      });
    }

    return new IntelligenceError(fallback, err.message, {
      cause: err,
      correlation,
    });
  }

  let text: string;
  try {
    text = typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    text = "Unknown error";
  }
  return new IntelligenceError(fallback, redactSecrets(text), {
    correlation,
    metadata: { retryable: false },
  });
}

function agentKindToFailureClass(kind: string): FailureClass {
  switch (kind) {
    case "model":
      return "model";
    case "tool":
      return "tool";
    case "permission":
      return "permission";
    case "sandbox":
      return "sandbox";
    case "context":
      return "context";
    case "subagent":
      return "model";
    case "configuration":
      return "configuration";
    case "cancellation":
      return "cancellation";
    default:
      return "unknown";
  }
}

function isAgentErrorLike(err: Error): err is Error & {
  kind: string;
  metadata?: { code?: string; retryable?: boolean };
} {
  const candidate = err as unknown as Record<string, unknown>;
  return (
    typeof candidate.kind === "string" && typeof candidate.metadata === "object"
  );
}

/** Whether a recovered error should trigger the self-repair loop. */
export function isRecoverable(err: unknown): boolean {
  if (err instanceof IntelligenceError) {
    if (err.isCancellation) {
      return false;
    }
    if (err.metadata.recoverable !== undefined) {
      return err.metadata.recoverable;
    }
    // Transient failure classes trigger the self-repair loop.
    return (
      err.failureClass === "model" ||
      err.failureClass === "tool" ||
      err.failureClass === "sandbox" ||
      err.failureClass === "verification"
    );
  }
  if (err instanceof Error) {
    return !err.name.includes("Abort");
  }
  return true;
}

/** Re-export the Phase 1 redaction helper so callers have one import path. */
export { redactSecrets, wrapError, type AgentError };
