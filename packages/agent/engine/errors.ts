/* eslint-disable max-classes-per-file */
/**
 * Vaulltcore Agent Engine — error taxonomy.
 *
 * The engine wraps provider/tool/sandbox errors at its boundary so the rest of
 * Vaulltcore never sees raw provider-specific error shapes. Diagnostic metadata
 * is preserved, but secrets (API keys, OAuth tokens, authorization headers) are
 * never leaked into user-facing errors.
 */

export type AgentErrorKind =
  | "model"
  | "tool"
  | "permission"
  | "sandbox"
  | "context"
  | "subagent"
  | "configuration"
  | "cancellation";

export interface AgentErrorMetadata {
  /** Stable machine-readable code, e.g. "tool.execution.failed". */
  code?: string;
  /** Provider/model that produced the error, when known. */
  provider?: string;
  model?: string;
  /** Tool name, when the error originated from a tool. */
  tool?: string;
  /** Subagent role, when the error originated from a subagent. */
  subagent?: string;
  /** Whether the error is retryable. */
  retryable?: boolean;
  /** Additional non-sensitive diagnostic context. */
  [key: string]: unknown;
}

export class AgentError extends Error {
  readonly kind: AgentErrorKind;
  readonly metadata: AgentErrorMetadata;
  /** True when this error was produced by user/operator cancellation. */
  readonly isCancellation: boolean;

  constructor(
    kind: AgentErrorKind,
    message: string,
    options: {
      metadata?: AgentErrorMetadata;
      cause?: unknown;
      isCancellation?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "AgentError";
    this.kind = kind;
    this.metadata = options.metadata ?? {};
    this.isCancellation = options.isCancellation ?? false;
    if (options.cause !== undefined) {
      // `cause` is part of the Error API; assign after super().
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class ModelError extends AgentError {
  constructor(
    message: string,
    metadata: AgentErrorMetadata = {},
    cause?: unknown,
  ) {
    super("model", message, { metadata, cause });
    this.name = "ModelError";
  }
}

export class ToolError extends AgentError {
  constructor(
    message: string,
    metadata: AgentErrorMetadata = {},
    cause?: unknown,
  ) {
    super("tool", message, { metadata, cause });
    this.name = "ToolError";
  }
}

export class PermissionError extends AgentError {
  constructor(
    message: string,
    metadata: AgentErrorMetadata = {},
    cause?: unknown,
  ) {
    super("permission", message, { metadata, cause });
    this.name = "PermissionError";
  }
}

export class SandboxError extends AgentError {
  constructor(
    message: string,
    metadata: AgentErrorMetadata = {},
    cause?: unknown,
  ) {
    super("sandbox", message, { metadata, cause });
    this.name = "SandboxError";
  }
}

export class ContextError extends AgentError {
  constructor(
    message: string,
    metadata: AgentErrorMetadata = {},
    cause?: unknown,
  ) {
    super("context", message, { metadata, cause });
    this.name = "ContextError";
  }
}

export class SubagentError extends AgentError {
  constructor(
    message: string,
    metadata: AgentErrorMetadata = {},
    cause?: unknown,
  ) {
    super("subagent", message, { metadata, cause });
    this.name = "SubagentError";
  }
}

export class ConfigurationError extends AgentError {
  constructor(
    message: string,
    metadata: AgentErrorMetadata = {},
    cause?: unknown,
  ) {
    super("configuration", message, { metadata, cause });
    this.name = "ConfigurationError";
  }
}

export class CancellationError extends AgentError {
  constructor(
    message = "Agent run was cancelled.",
    metadata: AgentErrorMetadata = {},
  ) {
    super("cancellation", message, { metadata, isCancellation: true });
    this.name = "CancellationError";
  }
}

/**
 * Patterns matching confidential material that must never appear in
 * user-facing error messages or logs.
 */
const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(?:api[_-]?key|apikey|secret|token|password|authorization)\s*[:=]\s*["']?[^\s"']+/gi,
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /xox[baprs]-[A-Za-z0-9-]+/g, // Slack tokens
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI keys
  /AIza[0-9A-Za-z_-]{35}/g, // Google API keys
];

export function redactSecrets(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match) => {
      const sep = match.match(/^(Bearer|[^=:]+[:=]\s*["']?)/i)?.[0] ?? "";
      return `${sep}[REDACTED]`;
    });
  }
  return output;
}

/**
 * Normalize an unknown thrown value into an `AgentError`. Non-error values
 * (strings, objects) are wrapped as `ConfigurationError` by default. Secrets in
 * the resulting message are redacted.
 */
export function wrapError(
  err: unknown,
  context: {
    kind?: AgentErrorKind;
    message?: string;
    metadata?: AgentErrorMetadata;
  } = {},
): AgentError {
  const message = context.message ?? safeMessage(err);
  const redacted = redactSecrets(message);
  const metadata = context.metadata ?? {};

  if (err instanceof AgentError) {
    return new AgentError(err.kind, redacted, {
      metadata: { ...err.metadata, ...metadata },
      cause: err,
      isCancellation: err.isCancellation,
    });
  }

  if (err instanceof Error) {
    const isAbort =
      err.name === "AbortError" ||
      err.name === "CancelledError" ||
      /abort|cancel/i.test(err.message);
    if (isAbort) {
      return new CancellationError(redacted, metadata);
    }
    return new AgentError(context.kind ?? "configuration", redacted, {
      metadata,
      cause: err,
    });
  }

  return new AgentError(context.kind ?? "configuration", redacted, {
    metadata,
    cause: err,
  });
}

function safeMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

export function isAgentError(value: unknown): value is AgentError {
  return value instanceof AgentError;
}
