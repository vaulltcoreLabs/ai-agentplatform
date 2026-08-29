/**
 * Vaulltcore Sandbox — runtime policy enforcement.
 *
 * Phase 4.4 closes the gap between the declarative `SandboxSecurityPolicy`
 * (see `./security`) and actual execution: previously those helpers were pure
 * functions consulted by *no* execution path — neither provider enforced path
 * confinement, command filtering, or file-size ceilings at its I/O boundary.
 *
 * `enforceSecurityPolicy` wraps ANY `Sandbox` implementation (Vercel, Docker,
 * in-memory test doubles) in a decorator that rejects violating operations
 * BEFORE they reach the inner sandbox. Enforcement points:
 *
 *  - All file reads/stats/mkdir/readdir: `confinePath` + `isPathDenied`.
 *  - writeFile: same, plus `checkFileSize` on the encoded byte length.
 *  - exec / execDetached: cwd confinement + `checkCommand` denylist/allowlist.
 *
 * Network egress remains a PROVIDER responsibility (a command string cannot
 * prove what sockets it opens); the host allowlist is surfaced here for
 * providers that consult `policy.network` internally. That boundary is
 * documented as CONTRACTUAL in docs/vaulltcore/phase4.4/security-audit.md.
 */

import type { Dirent } from "fs";
import type {
  ExecResult,
  Sandbox,
  SandboxStats,
  SnapshotResult,
} from "./interface.ts";
import { SandboxError } from "./errors.ts";
import {
  checkCommand,
  checkFileSize,
  confinePath,
  isPathDenied,
  type SandboxSecurityPolicy,
} from "./security.ts";

/** Thrown when an operation violates the active security policy. */
export class SandboxPolicyViolationError extends SandboxError {
  constructor(
    operation: string,
    readonly reason: string,
  ) {
    super(`sandbox policy violation (${operation}): ${reason}`, {
      metadata: { operation },
    });
    this.name = "SandboxPolicyViolationError";
  }
}

function confine(
  inputPath: string,
  policy: SandboxSecurityPolicy,
  operation: string,
): string {
  const confined = confinePath(inputPath, policy.path);
  if (confined === undefined) {
    throw new SandboxPolicyViolationError(
      operation,
      `path escapes allowed root ${policy.path.allowedRoot}: ${inputPath}`,
    );
  }
  const denied = isPathDenied(inputPath, policy.path);
  if (!denied.allowed) {
    throw new SandboxPolicyViolationError(operation, denied.reason ?? "denied");
  }
  return confined;
}

function requireCommandAllowed(
  command: string,
  policy: SandboxSecurityPolicy,
): void {
  const result = checkCommand(command, policy.command);
  if (!result.allowed) {
    throw new SandboxPolicyViolationError(
      "exec",
      result.reason ?? "command denied",
    );
  }
}

function requireCwdConfined(cwd: string, policy: SandboxSecurityPolicy): void {
  if (confinePath(cwd, policy.path) === undefined) {
    throw new SandboxPolicyViolationError(
      "exec",
      `cwd escapes allowed root ${policy.path.allowedRoot}: ${cwd}`,
    );
  }
}

/**
 * Wrap a sandbox so every I/O boundary enforces `policy`. The wrapper is
 * transparent for lifecycle operations (`stop`, `getState`, hooks, etc.).
 */
export function enforceSecurityPolicy(
  inner: Sandbox,
  policy: SandboxSecurityPolicy,
): Sandbox {
  const readFile = async (path: string, encoding: "utf-8"): Promise<string> => {
    confine(path, policy, "readFile");
    return inner.readFile(path, encoding);
  };

  const readFileBuffer = async (path: string): Promise<Buffer> => {
    confine(path, policy, "readFileBuffer");
    return inner.readFileBuffer(path);
  };

  const writeFile = async (
    path: string,
    content: string,
    encoding: "utf-8",
  ): Promise<void> => {
    const confined = confine(path, policy, "writeFile");
    const size = Buffer.byteLength(content, "utf-8");
    const sizeCheck = checkFileSize(size, policy);
    if (!sizeCheck.allowed) {
      throw new SandboxPolicyViolationError(
        "writeFile",
        sizeCheck.reason ?? "file too large",
      );
    }
    return inner.writeFile(confined, content, encoding);
  };

  const stat = async (path: string): Promise<SandboxStats> => {
    confine(path, policy, "stat");
    return inner.stat(path);
  };

  const access = async (path: string): Promise<void> => {
    confine(path, policy, "access");
    return inner.access(path);
  };

  const mkdir = async (
    path: string,
    options?: { recursive?: boolean },
  ): Promise<void> => {
    confine(path, policy, "mkdir");
    return inner.mkdir(path, options);
  };

  const readdir = async (
    path: string,
    options: { withFileTypes: true },
  ): Promise<Dirent[]> => {
    confine(path, policy, "readdir");
    return inner.readdir(path, options);
  };

  // Async on purpose: violations must surface as rejected promises, not
  // synchronous throws that escape an `await`-based call site.
  const exec = async (
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> => {
    requireCommandAllowed(command, policy);
    requireCwdConfined(cwd, policy);
    return inner.exec(command, cwd, timeoutMs, options);
  };

  const wrapped: Sandbox = {
    type: inner.type,
    workingDirectory: inner.workingDirectory,
    ...(inner.env !== undefined ? { env: inner.env } : {}),
    ...(inner.currentBranch !== undefined
      ? { currentBranch: inner.currentBranch }
      : {}),
    ...(inner.hooks !== undefined ? { hooks: inner.hooks } : {}),
    ...(inner.environmentDetails !== undefined
      ? { environmentDetails: inner.environmentDetails }
      : {}),
    ...(inner.host !== undefined ? { host: inner.host } : {}),
    ...(inner.expiresAt !== undefined ? { expiresAt: inner.expiresAt } : {}),
    ...(inner.timeout !== undefined ? { timeout: inner.timeout } : {}),

    readFile,
    readFileBuffer,
    writeFile,
    stat,
    access,
    mkdir,
    readdir,
    exec,

    stop: () => inner.stop(),
    ...(inner.execDetached
      ? {
          execDetached: async (command: string, cwd: string) => {
            requireCommandAllowed(command, policy);
            requireCwdConfined(cwd, policy);
            return inner.execDetached!(command, cwd);
          },
        }
      : {}),
    ...(inner.setGitHubAuthToken
      ? {
          setGitHubAuthToken: (token?: string) =>
            inner.setGitHubAuthToken!(token),
        }
      : {}),
    ...(inner.domain ? { domain: (port: number) => inner.domain!(port) } : {}),
    ...(inner.extendTimeout
      ? {
          extendTimeout: (additionalMs: number) =>
            inner.extendTimeout!(additionalMs),
        }
      : {}),
    ...(inner.snapshot
      ? { snapshot: (): Promise<SnapshotResult> => inner.snapshot!() }
      : {}),
    ...(inner.getState ? { getState: () => inner.getState!() } : {}),
  };

  return wrapped;
}
