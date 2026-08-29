/**
 * Vaulltcore Sandbox — security policy boundary.
 *
 * Phase 4.3 hardens the sandbox boundary with structured security policies.
 * These are provider-neutral: a `SandboxSecurityPolicy` can be applied to
 * any `Sandbox` implementation (Vercel, Docker, in-memory) by wrapping the
 * implementation at the provider boundary.
 *
 * Policies enforce:
 *  - Network egress: deny-by-default with an explicit allowlist.
 *  - Path confinement: all file operations are resolved and checked against
 *    an allowed root, blocking traversal (`../`) escape attempts.
 *  - Command allowlist: a per-sandbox command pattern filter used by the
 *    bash tool and executor to reject dangerous commands before they reach
 *    `exec`.
 *  - File-size ceiling: read/write operations reject files exceeding a
 *    configurable byte limit.
 */

import { resolve, normalize, relative } from "node:path";

/**
 * Network egress policy. `deny-by-default` with an explicit allowlist of host
 * glob patterns. `*` matches any host (full egress). An empty allowlist
 * blocks all egress.
 */
export interface NetworkPolicyConfig {
  /**
   * Allowlist of host patterns. `*:` matches any host. `*.example.com`
   * matches that host and subdomains. An empty array blocks all egress.
   */
  readonly allowedHosts: readonly string[];
  /**
   * If true, unknown hosts are denied (default). If false, unknown hosts
   * are allowed (legacy permissive behavior). Must be explicitly set.
   */
  readonly defaultDeny: boolean;
}

/**
 * Path confinement policy. All file reads/writes are resolved relative to an
 * allowed root directory and checked against escape attempts.
 */
export interface PathPolicyConfig {
  /**
   * The canonical root directory all access is confined to.
   * Paths outside this root (after resolution) are rejected.
   */
  readonly allowedRoot: string;
  /**
   * Glob patterns of paths to reject even within the root (e.g. `.env`
   * files, `.git` internals). These are checked after path confinement.
   */
  readonly deniedPaths: readonly string[];
}

/**
 * Command filtering policy. Commands are tokenized and matched against
 * allowlist/denylist patterns before reaching the sandbox exec layer.
 */
export interface CommandPolicyConfig {
  /**
   * Patterns that are always rejected. Uses substring matching on the
   * full command string. Checked *before* the allowlist.
   */
  readonly deniedCommandPatterns: readonly string[];
  /**
   * Patterns that must appear in an allowed command string. If non-empty,
   * a command must match at least one allow pattern to be permitted.
   * Empty means "all non-denied commands are allowed".
   */
  readonly allowedCommandPatterns: readonly string[];
}

/**
 * Full sandbox security policy. Applied by the provider at connect/create time.
 */
export interface SandboxSecurityPolicy {
  readonly network: NetworkPolicyConfig;
  readonly path: PathPolicyConfig;
  readonly command: CommandPolicyConfig;
  /** Maximum byte size for file read/write operations. */
  readonly maxFileSizeBytes: number;
  /** Default execution timeout for sandboxed commands (ms). */
  readonly defaultExecTimeoutMs: number;
}

/** Deny-by-default network egress with no hosts allowed. */
export const DENY_ALL_NETWORK: NetworkPolicyConfig = {
  allowedHosts: [],
  defaultDeny: true,
};

/** Permit all egress (legacy behavior — use only for migration). */
export const ALLOW_ALL_NETWORK: NetworkPolicyConfig = {
  allowedHosts: ["*"],
  defaultDeny: false,
};

export const GITHUB_EGRESS_NETWORK: NetworkPolicyConfig = {
  allowedHosts: [
    "api.github.com",
    "uploads.github.com",
    "codeload.github.com",
    "github.com",
  ],
  defaultDeny: true,
};

/**
 * Default path policy. Confines all access to the sandbox working directory
 * and denies dotfiles that may contain secrets.
 */
export function defaultPathPolicy(workingDirectory: string): PathPolicyConfig {
  return {
    allowedRoot: resolve(workingDirectory),
    deniedPaths: [
      ".env",
      ".env.local",
      ".env.*.local",
      ".git/config",
      ".git/credentials",
    ],
  };
}

/**
 * Default command policy. Denylist of dangerous patterns; allowlist empty
 * (all non-denied commands permitted).
 */
export function defaultCommandPolicy(): CommandPolicyConfig {
  return {
    deniedCommandPatterns: [
      "fork bomb",
      ":(){:|:&};:",
      "rm -rf /",
      "rm -fr /",
      "rm -r -f /",
      "rm -f -r /",
      "chmod 777",
      "curl -o /dev/stdin | bash",
      "eval $(",
      "shutdown",
      "reboot",
      "halt -p",
      "mkfs",
    ],
    allowedCommandPatterns: [],
  };
}

export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/**
 * Default security policy for a sandbox. Deny-by-default network, path
 * confinement to the working directory, command denylist, and 10MB file size
 * ceiling.
 */
export function defaultSecurityPolicy(
  workingDirectory: string,
): SandboxSecurityPolicy {
  return {
    network: DENY_ALL_NETWORK,
    path: defaultPathPolicy(workingDirectory),
    command: defaultCommandPolicy(),
    maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
    defaultExecTimeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
  };
}

/**
 * Result of a security check. When rejected, carries the reason for logging
 * and error reporting.
 */
export interface SecurityCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Check whether a host is permitted by the network policy.
 */
export function checkHost(
  host: string,
  policy: NetworkPolicyConfig,
): SecurityCheckResult {
  for (const pattern of policy.allowedHosts) {
    if (pattern === "*") {
      return {
        allowed: !policy.defaultDeny,
        reason: "allow-all",
      };
    }
    if (matchHostPattern(pattern, host)) {
      return { allowed: true, reason: `allowed:${pattern}` };
    }
  }
  return {
    allowed: !policy.defaultDeny,
    reason: policy.defaultDeny ? "denied-by-default" : "allowed-by-default",
  };
}

function matchHostPattern(pattern: string, host: string): boolean {
  if (pattern === host) {
    return true;
  }
  if (pattern.startsWith("*.") && host.endsWith(pattern.slice(1))) {
    return true;
  }
  return false;
}

/**
 * Resolve and confine a path to the allowed root. Returns the resolved path
 * if within bounds, or `undefined` if it escapes.
 */
export function confinePath(
  inputPath: string,
  policy: PathPolicyConfig,
): string | undefined {
  const resolved = resolve(policy.allowedRoot, inputPath);

  // Prevent traversal: resolved path must start with the allowed root.
  const rel = relative(policy.allowedRoot, resolved);
  if (rel.startsWith("..") || rel === "..") {
    return undefined;
  }

  return resolved;
}

/**
 * Check whether a path is in the denied list (secrets, .git internals).
 */
export function isPathDenied(
  inputPath: string,
  policy: PathPolicyConfig,
): SecurityCheckResult {
  const normalized = normalize(inputPath);
  for (const denied of policy.deniedPaths) {
    if (normalized.includes(denied)) {
      return { allowed: false, reason: `denied:${denied}` };
    }
  }
  return { allowed: true };
}

/**
 * Check a command against the command policy. Returns rejected if any denied
 * pattern matches or (when an allowlist exists) no allow pattern matches.
 */
export function checkCommand(
  command: string,
  policy: CommandPolicyConfig,
): SecurityCheckResult {
  // Normalize whitespace before denylist matching: otherwise trivial spacing
  // changes (e.g. `:(){ :|:& };:` vs `:(){:|:&};:`) evade the fork-bomb and
  // other multi-token patterns.
  const normalizedCommand = command.replace(/\s+/g, "");
  for (const pattern of policy.deniedCommandPatterns) {
    const normalizedPattern = pattern.replace(/\s+/g, "");
    if (
      command.includes(pattern) ||
      (normalizedPattern.length > 0 &&
        normalizedCommand.includes(normalizedPattern))
    ) {
      return { allowed: false, reason: `denied:${pattern}` };
    }
  }

  if (policy.allowedCommandPatterns.length > 0) {
    const matched = policy.allowedCommandPatterns.some((p) =>
      command.includes(p),
    );
    if (!matched) {
      return { allowed: false, reason: "no-allow-pattern-matched" };
    }
  }

  return { allowed: true };
}

/**
 * Check a file size against the policy ceiling.
 */
export function checkFileSize(
  size: number,
  policy: SandboxSecurityPolicy,
): SecurityCheckResult {
  if (size > policy.maxFileSizeBytes) {
    return {
      allowed: false,
      reason: `file size ${size} exceeds max ${policy.maxFileSizeBytes}`,
    };
  }
  return { allowed: true };
}
