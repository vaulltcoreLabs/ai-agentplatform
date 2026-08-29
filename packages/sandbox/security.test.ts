import { describe, expect, it } from "bun:test";
import {
  checkHost,
  confinePath,
  checkCommand,
  checkFileSize,
  isPathDenied,
  defaultSecurityPolicy,
  defaultPathPolicy,
  defaultCommandPolicy,
  DENY_ALL_NETWORK,
  ALLOW_ALL_NETWORK,
  GITHUB_EGRESS_NETWORK,
} from "./security";

const WORKSPACE = "/workspace/repo";

describe("SandboxSecurityPolicy — adversarial path traversal", () => {
  const policy = defaultPathPolicy(WORKSPACE);

  it("blocks ../../../etc/passwd traversal", () => {
    const result = confinePath("../../../etc/passwd", policy);
    expect(result).toBeUndefined();
  });

  it("blocks absolute path escape outside working directory", () => {
    const result = confinePath("/etc/shadow", policy);
    expect(result).toBeUndefined();
  });

  it("blocks deeply nested traversal (../../../../../../)", () => {
    const result = confinePath("../../../../../../../../etc/passwd", policy);
    expect(result).toBeUndefined();
  });

  it("blocks traversal via symlink-style path (../subdir/../../escape)", () => {
    const result = confinePath("../subdir/../../escape", policy);
    expect(result).toBeUndefined();
  });

  it("blocks traversal to /tmp", () => {
    const result = confinePath("../../tmp/agent_secrets", policy);
    expect(result).toBeUndefined();
  });

  it("allows legitimate paths within working directory", () => {
    const result = confinePath("src/index.ts", policy);
    expect(result).toBeDefined();
    expect(result).toContain("src/index.ts");
  });

  it("allows nested paths within working directory", () => {
    const result = confinePath("packages/app/src/utils/logger.ts", policy);
    expect(result).toBeDefined();
  });
});

describe("SandboxSecurityPolicy — denials for secret files", () => {
  const policy = defaultPathPolicy(WORKSPACE);

  it("blocks .env file access", () => {
    const result = isPathDenied(".env", policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(".env");
  });

  it("blocks .env.local file access", () => {
    const result = isPathDenied(".env.local", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks .env.*.local pattern via substring", () => {
    const result = isPathDenied(".env.production.local", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks .git/config access", () => {
    const result = isPathDenied(".git/config", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks .git/credentials access", () => {
    const result = isPathDenied(".git/credentials", policy);
    expect(result.allowed).toBe(false);
  });

  it("allows non-secret files", () => {
    const result = isPathDenied("src/app.ts", policy);
    expect(result.allowed).toBe(true);
  });
});

describe("SandboxSecurityPolicy — command denylist", () => {
  const policy = defaultCommandPolicy();

  it("blocks fork bomb variant ':(){:|:&};:'", () => {
    const result = checkCommand(":(){:|:&};:", policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(":(){:|:&};:");
  });

  it("blocks 'fork bomb' string", () => {
    const result = checkCommand("fork bomb", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks 'rm -rf /'", () => {
    const result = checkCommand("rm -rf /", policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("rm -rf /");
  });

  it("blocks 'chmod 777'", () => {
    const result = checkCommand("chmod 777 /etc/passwd", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks 'curl -o /dev/stdin | bash'", () => {
    const result = checkCommand("curl -o /dev/stdin | bash", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks 'eval $(...'", () => {
    const result = checkCommand("eval $(cat secret)", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks 'shutdown'", () => {
    const result = checkCommand("shutdown -h now", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks 'reboot'", () => {
    const result = checkCommand("reboot", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks 'halt -p'", () => {
    const result = checkCommand("halt -p", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks 'mkfs'", () => {
    const result = checkCommand("mkfs.ext4 /dev/sda1", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks fork bombs with arbitrary internal spacing (whitespace evasion)", () => {
    // Regression: denylist matching normalizes whitespace so spacing variants
    // of a denied pattern cannot evade the filter.
    const result = checkCommand(":(){ :|:& };:", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks 'rm -rf /' with extra spaces between flags", () => {
    expect(checkCommand("rm -r -f /", policy).allowed).toBe(false);
    expect(checkCommand("rm   -rf   /", policy).allowed).toBe(false);
  });

  it("allows safe commands", () => {
    const result = checkCommand("ls -la", policy);
    expect(result.allowed).toBe(true);
  });

  it("allows safe commands with args", () => {
    const result = checkCommand("git status --short", policy);
    expect(result.allowed).toBe(true);
  });
});

describe("SandboxSecurityPolicy — network egress", () => {
  it("DENY_ALL_NETWORK blocks arbitrary hosts", () => {
    expect(checkHost("evil.com", DENY_ALL_NETWORK).allowed).toBe(false);
    expect(checkHost("api.github.com", DENY_ALL_NETWORK).allowed).toBe(false);
    expect(checkHost("127.0.0.1", DENY_ALL_NETWORK).allowed).toBe(false);
    expect(
      checkHost("metadata.google.internal", DENY_ALL_NETWORK).allowed,
    ).toBe(false);
  });

  it("GITHUB_EGRESS_NETWORK allows GitHub hosts", () => {
    expect(checkHost("api.github.com", GITHUB_EGRESS_NETWORK).allowed).toBe(
      true,
    );
    expect(
      checkHost("codeload.github.com", GITHUB_EGRESS_NETWORK).allowed,
    ).toBe(true);
    expect(checkHost("github.com", GITHUB_EGRESS_NETWORK).allowed).toBe(true);
  });

  it("GITHUB_EGRESS_NETWORK blocks non-GitHub hosts", () => {
    expect(checkHost("evil.com", GITHUB_EGRESS_NETWORK).allowed).toBe(false);
    expect(checkHost("169.254.169.254", GITHUB_EGRESS_NETWORK).allowed).toBe(
      false,
    );
  });

  it("ALLOW_ALL_NETWORK permits everything", () => {
    expect(checkHost("evil.com", ALLOW_ALL_NETWORK).allowed).toBe(true);
    expect(checkHost("127.0.0.1", ALLOW_ALL_NETWORK).allowed).toBe(true);
    expect(
      checkHost("metadata.google.internal", ALLOW_ALL_NETWORK).allowed,
    ).toBe(true);
  });

  it("blocks cloud metadata endpoint (169.254.169.254)", () => {
    const policy = defaultSecurityPolicy(WORKSPACE);
    expect(checkHost("169.254.169.254", policy.network).allowed).toBe(false);
  });
});

describe("SandboxSecurityPolicy — file size ceiling", () => {
  const policy = defaultSecurityPolicy(WORKSPACE);

  it("allows files within the 10MB ceiling", () => {
    expect(checkFileSize(1024, policy).allowed).toBe(true);
    expect(checkFileSize(1_000_000, policy).allowed).toBe(true);
    expect(checkFileSize(5_000_000, policy).allowed).toBe(true);
  });

  it("blocks files exceeding 10MB", () => {
    expect(checkFileSize(10 * 1024 * 1024 + 1, policy).allowed).toBe(false);
    expect(checkFileSize(100 * 1024 * 1024, policy).allowed).toBe(false);
  });
});

describe("SandboxSecurityPolicy — default policy integration", () => {
  it("default policy is deny-by-default for network", () => {
    const policy = defaultSecurityPolicy(WORKSPACE);
    expect(policy.network.defaultDeny).toBe(true);
    expect(policy.network.allowedHosts).toHaveLength(0);
  });

  it("default policy confines paths to working directory", () => {
    const policy = defaultSecurityPolicy(WORKSPACE);
    expect(policy.path.allowedRoot).toBe(WORKSPACE);
    expect(policy.path.deniedPaths.length).toBeGreaterThan(0);
  });

  it("default policy has command denylist", () => {
    const policy = defaultSecurityPolicy(WORKSPACE);
    expect(policy.command.deniedCommandPatterns.length).toBeGreaterThan(0);
    expect(policy.command.allowedCommandPatterns).toHaveLength(0);
  });
});
