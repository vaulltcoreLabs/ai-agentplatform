/* eslint-disable max-classes-per-file */
/**
 * Base error for all sandbox-related failures.
 *
 * Carries structured `metadata` so callers (and the Agent Engine) can inspect
 * the failing sandbox/provider without string-matching error messages.
 */
export class SandboxError extends Error {
  /**
   * Optional structured context about the failure.
   * Avoids embedding secrets; callers should treat values as
   * diagnostic-only.
   */
  readonly metadata?: Record<string, unknown>;

  constructor(
    message: string,
    options?: { cause?: unknown; metadata?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "SandboxError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    if (options?.metadata !== undefined) {
      this.metadata = options.metadata;
    }
  }

  override get cause(): unknown {
    return (this as { cause?: unknown }).cause;
  }
}

/**
 * The requested sandbox provider is not registered or unsupported.
 * Most commonly: connecting to/dispatching a `type` that no installed
 * provider handles.
 */
export class SandboxProviderError extends SandboxError {
  constructor(
    message: string,
    options?: { cause?: unknown; metadata?: Record<string, unknown> },
  ) {
    super(message, options);
    this.name = "SandboxProviderError";
  }
}

/**
 * A sandbox that was expected to exist could not be found (e.g. a
 * reconnect to a named sandbox that was torn down).
 */
export class SandboxNotFoundError extends SandboxError {
  constructor(
    message: string,
    options?: { cause?: unknown; metadata?: Record<string, unknown> },
  ) {
    super(message, options);
    this.name = "SandboxNotFoundError";
  }
}

/**
 * A requested sandbox capability is not supported by the current
 * provider (e.g. snapshots on Docker, or `domain` on a non-Vercel sandbox).
 */
export class SandboxCapabilityError extends SandboxError {
  constructor(
    message: string,
    options?: { cause?: unknown; metadata?: Record<string, unknown> },
  ) {
    super(message, options);
    this.name = "SandboxCapabilityError";
  }
}

/**
 * A sandbox could not be provisioned in the underlying backend
 * (create/resolve failure that is not a missing-resource condition).
 */
export class SandboxProvisionError extends SandboxError {
  constructor(
    message: string,
    options?: { cause?: unknown; metadata?: Record<string, unknown> },
  ) {
    super(message, options);
    this.name = "SandboxProvisionError";
  }
}
