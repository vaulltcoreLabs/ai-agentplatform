import { describe, expect, test, mock } from "bun:test";
import { DockerSandbox, MemoryContainerRuntime } from "./index";
import type { ExecResult } from "../interface";
import { SandboxCapabilityError, SandboxNotFoundError } from "../errors";

function makeSandbox(runtime?: MemoryContainerRuntime) {
  const rt =
    runtime ??
    new MemoryContainerRuntime({ id: "c1", workingDirectory: "/repo" });
  return new DockerSandbox({
    runtime: rt,
    config: { name: "c1", workingDirectory: "/repo" },
  });
}

describe("DockerSandbox", () => {
  test("exposes type and environment details", () => {
    const sandbox = makeSandbox();
    expect(sandbox.type).toBe("docker");
    expect(sandbox.environmentDetails).toMatch(/Docker container c1/);
  });

  test("exec forwards command and options to the runtime", async () => {
    const exec = mock(
      async (_command: string, _options?: unknown): Promise<ExecResult> => ({
        success: true,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        truncated: false,
      }),
    );
    const runtime = new MemoryContainerRuntime({
      id: "c1",
      workingDirectory: "/repo",
      exec,
    });
    const sandbox = makeSandbox(runtime);

    const result = await sandbox.exec("echo hi", "/repo", 5_000, {
      signal: undefined,
    });

    expect(exec).toHaveBeenCalledTimes(1);
    const [command, options] = exec.mock.calls[0]!;
    expect(command).toBe("echo hi");
    expect((options as { cwd: string; timeoutMs: number }).cwd).toBe("/repo");
    expect((options as { timeoutMs: number }).timeoutMs).toBe(5_000);
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("ok");
  });

  test("exec returns failure results without throwing", async () => {
    const runtime = new MemoryContainerRuntime({
      id: "c1",
      workingDirectory: "/repo",
      exec: async () => ({
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: "boom",
        truncated: false,
      }),
    });
    const sandbox = makeSandbox(runtime);
    const result = await sandbox.exec("git bad", "/repo", 1_000);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("boom");
  });

  test("writeFile/readFile/readFileBuffer round-trip text", async () => {
    const sandbox = makeSandbox();
    await sandbox.writeFile("/repo/foo.txt", "hello", "utf-8");
    expect(await sandbox.readFile("/repo/foo.txt", "utf-8")).toBe("hello");
    expect((await sandbox.readFileBuffer("/repo/foo.txt")).toString()).toBe(
      "hello",
    );
  });

  test("mkdir and readdir surface created entries", async () => {
    const sandbox = makeSandbox();
    await sandbox.writeFile("/repo/a.txt", "a", "utf-8");
    await sandbox.mkdir("/repo/sub");
    const entries = await sandbox.readdir("/repo", { withFileTypes: true });
    expect(entries.map((d) => d.name).sort()).toEqual(["a.txt", "sub"]);
  });

  test("stat reports file metadata", async () => {
    const sandbox = makeSandbox();
    await sandbox.writeFile("/repo/foo.txt", "hello", "utf-8");
    const stats = await sandbox.stat("/repo/foo.txt");
    expect(stats.size).toBe(5);
    expect(stats.isFile()).toBe(true);
    expect(stats.isDirectory()).toBe(false);
  });

  test("access rejects for missing files", async () => {
    const sandbox = makeSandbox();
    await expect(sandbox.access("/repo/missing.txt")).rejects.toThrow();
  });

  test("snapshot throws a capability error", async () => {
    const sandbox = makeSandbox();
    await expect(sandbox.snapshot()).rejects.toThrow(SandboxCapabilityError);
  });

  test("after stop, further operations throw sandbox not found", async () => {
    const sandbox = makeSandbox();
    await sandbox.stop();
    expect(sandbox.type).toBe("docker");
    await expect(sandbox.exec("echo", "/repo", 1_000)).rejects.toThrow(
      SandboxNotFoundError,
    );
    await expect(sandbox.readFile("/repo/foo.txt", "utf-8")).rejects.toThrow(
      SandboxNotFoundError,
    );
  });

  test("does not broker GitHub auth", () => {
    const sandbox = makeSandbox();
    expect(
      (sandbox as unknown as { setGitHubAuthToken?: unknown })
        .setGitHubAuthToken,
    ).toBeUndefined();
  });

  test("getState returns a serializable Docker state", () => {
    const sandbox = makeSandbox();
    expect(sandbox.getState()).toEqual({ type: "docker", sandboxName: "c1" });
  });

  test("stop is idempotent", async () => {
    const sandbox = makeSandbox();
    await sandbox.stop();
    await sandbox.stop();
  });
});
