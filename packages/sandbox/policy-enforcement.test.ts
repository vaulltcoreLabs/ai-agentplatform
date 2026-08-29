/**
 * Adversarial tests for runtime policy enforcement (Phase 4.4).
 *
 * These prove that `enforceSecurityPolicy` actually blocks malicious
 * operations at the sandbox boundary — not merely that helper functions
 * return negative results.
 */

import { describe, expect, it } from "bun:test";
import type { Sandbox } from "./interface.ts";
import { defaultSecurityPolicy, GITHUB_EGRESS_NETWORK } from "./security.ts";
import {
  enforceSecurityPolicy,
  SandboxPolicyViolationError,
} from "./policy-enforcement.ts";

const ROOT = "/workspace/repo";

/** A permissive in-memory sandbox representing an unhardened provider. */
interface RecordingSandbox extends Sandbox {
  readonly writes: string[];
  readonly execs: string[];
}

function permissiveSandbox(): RecordingSandbox & { stopped: boolean } {
  const writes: string[] = [];
  const execs: string[] = [];
  const files = new Map<string, string>();
  const sandbox: RecordingSandbox & { stopped: boolean } = {
    type: "docker",
    workingDirectory: ROOT,
    writes,
    execs,
    async readFile(path: string): Promise<string> {
      // Deliberately unhardened: reads ANY path it is asked for.
      if (path.includes("secret")) {
        return "SUPER_SECRET_VALUE";
      }
      return files.get(path) ?? "";
    },
    async readFileBuffer(path: string): Promise<Buffer> {
      return Buffer.from(await this.readFile(path, "utf-8"));
    },
    async writeFile(path: string, content: string): Promise<void> {
      writes.push(`${path}:${content.length}`);
      files.set(path, content);
    },
    async stat(path: string) {
      return {
        isDirectory: () => false,
        isFile: () => true,
        size: files.get(path)?.length ?? 0,
        mtimeMs: 0,
      };
    },
    async access(): Promise<void> {},
    async mkdir(): Promise<void> {},
    async readdir(path: string, _o: { withFileTypes: true }) {
      void path;
      return [];
    },
    async exec(command: string): Promise<{
      success: boolean;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      truncated: boolean;
    }> {
      execs.push(command);
      return {
        success: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
      };
    },
    stopped: false,
    async stop(): Promise<void> {
      sandbox.stopped = true;
    },
  };
  return sandbox;
}

describe("policy-enforcement — path traversal is blocked at the boundary", () => {
  const policy = defaultSecurityPolicy(ROOT);

  it("readFile rejects traversal outside the root", async () => {
    const inner = permissiveSandbox();
    const s = enforceSecurityPolicy(inner, policy);
    await expect(s.readFile("../../../etc/passwd", "utf-8")).rejects.toThrow(
      SandboxPolicyViolationError,
    );
    await expect(s.readFileBuffer("../../../../etc/shadow")).rejects.toThrow(
      SandboxPolicyViolationError,
    );
  });

  it("readFile rejects absolute escape paths", async () => {
    const s = enforceSecurityPolicy(permissiveSandbox(), policy);
    await expect(s.readFile("/etc/shadow", "utf-8")).rejects.toThrow(
      SandboxPolicyViolationError,
    );
  });

  it("writeFile rejects traversal and denied secret paths", async () => {
    const inner = permissiveSandbox();
    const s = enforceSecurityPolicy(inner, policy);
    await expect(s.writeFile("../escape.ts", "x", "utf-8")).rejects.toThrow(
      SandboxPolicyViolationError,
    );
    await expect(s.writeFile(".env.local", "KEY=1", "utf-8")).rejects.toThrow(
      SandboxPolicyViolationError,
    );
    expect(inner.writes).toHaveLength(0);
  });

  it("stat/access/mkdir/readdir reject escapes", async () => {
    const s = enforceSecurityPolicy(permissiveSandbox(), policy);
    await expect(s.stat("/proc/self/environ")).rejects.toThrow(
      SandboxPolicyViolationError,
    );
    await expect(s.access("../../root/.ssh")).rejects.toThrow(
      SandboxPolicyViolationError,
    );
    await expect(s.mkdir("/etc/evil", { recursive: true })).rejects.toThrow(
      SandboxPolicyViolationError,
    );
    await expect(s.readdir("/sys", { withFileTypes: true })).rejects.toThrow(
      SandboxPolicyViolationError,
    );
  });
});

describe("policy-enforcement — command policy is enforced before exec", () => {
  const policy = defaultSecurityPolicy(ROOT);

  it("blocks fork bombs, rm -rf /, and mkfs before reaching the provider", async () => {
    const inner = permissiveSandbox();
    const s = enforceSecurityPolicy(inner, policy);
    for (const cmd of [
      ":(){ :|:& };:",
      "rm -rf /",
      "mkfs.ext4 /dev/sda1",
      "shutdown -h now",
    ]) {
      await expect(s.exec(cmd, ROOT, 1000)).rejects.toThrow(
        SandboxPolicyViolationError,
      );
    }
    expect(inner.execs).toHaveLength(0);
  });

  it("allows legitimate commands within the workspace", async () => {
    const inner = permissiveSandbox();
    const s = enforceSecurityPolicy(inner, policy);
    const result = await s.exec("git status --short", ROOT, 1000);
    expect(result.exitCode).toBe(0);
    expect(inner.execs).toEqual(["git status --short"]);
  });

  it("blocks exec with a cwd outside the allowed root", async () => {
    const inner = permissiveSandbox();
    const s = enforceSecurityPolicy(inner, policy);
    await expect(s.exec("ls", "/tmp", 1000)).rejects.toThrow(
      SandboxPolicyViolationError,
    );
    expect(inner.execs).toHaveLength(0);
  });

  it("blocks detached exec of denied commands", async () => {
    const inner = permissiveSandbox();
    inner.execDetached = async () => ({ commandId: "c1" });
    const s = enforceSecurityPolicy(inner, policy);
    await expect(s.execDetached!("rm -rf /", ROOT)).rejects.toThrow(
      SandboxPolicyViolationError,
    );
  });
});

describe("policy-enforcement — file-size ceiling", () => {
  it("writeFile rejects oversized payloads without touching the provider", async () => {
    const policy = defaultSecurityPolicy(ROOT);
    const inner = permissiveSandbox();
    const s = enforceSecurityPolicy(inner, policy);
    const big = "x".repeat(policy.maxFileSizeBytes + 1);
    await expect(s.writeFile("big.bin", big, "utf-8")).rejects.toThrow(
      SandboxPolicyViolationError,
    );
    expect(inner.writes).toHaveLength(0);
  });
});

describe("policy-enforcement — transparency", () => {
  it("delegates lifecycle operations to the inner sandbox", async () => {
    const inner = permissiveSandbox();
    const s = enforceSecurityPolicy(inner, defaultSecurityPolicy(ROOT));
    expect(s.type).toBe("docker");
    expect(s.workingDirectory).toBe(ROOT);
    await s.stop();
    expect((inner as unknown as { stopped: boolean }).stopped).toBe(true);
  });

  it("network host policy remains provider-enforced but is queryable", () => {
    // Documenting the boundary: command strings cannot prove socket behavior.
    // The host allowlist is part of the policy contract for providers that
    // consult it (see docs/vaulltcore/phase4.4/security-audit.md).
    expect(GITHUB_EGRESS_NETWORK.defaultDeny).toBe(true);
    expect(GITHUB_EGRESS_NETWORK.allowedHosts).not.toContain("*");
  });
});
