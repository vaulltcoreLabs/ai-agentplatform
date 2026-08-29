import { beforeEach, describe, expect, mock, test } from "bun:test";
// Spread the real module namespace into the mock: `mock.module` replaces the
// module registry process-wide under `bun test`, so a partial mock would break
// other test files importing untouched exports from "@vaulltcore/sandbox".
import * as realSandboxModule from "@vaulltcore/sandbox";

const connectSandboxCalls: unknown[][] = [];

let connectSandboxResult: unknown = {
  workingDirectory: "/repo",
};

mock.module("@vaulltcore/sandbox", () => ({
  ...realSandboxModule,
  connectSandbox: async (...args: unknown[]) => {
    connectSandboxCalls.push(args);
    return connectSandboxResult;
  },
}));

const {
  getSandbox,
  getSandboxContext,
  isPathWithinDirectory,
  shellEscape,
  toDisplayPath,
} = await import("./utils");

beforeEach(() => {
  connectSandboxCalls.length = 0;
  connectSandboxResult = {
    workingDirectory: "/repo",
  };
});

describe("tools/utils", () => {
  test("isPathWithinDirectory handles nested and sibling paths", () => {
    expect(isPathWithinDirectory("/repo/src/index.ts", "/repo")).toBe(true);
    expect(isPathWithinDirectory("/repo", "/repo")).toBe(true);
    expect(isPathWithinDirectory("/repo-other/src/index.ts", "/repo")).toBe(
      false,
    );
  });

  test("toDisplayPath returns workspace-relative paths when possible", () => {
    expect(toDisplayPath("/repo/src/index.ts", "/repo")).toBe("src/index.ts");
    expect(toDisplayPath("src/index.ts", "/repo")).toBe("src/index.ts");
    expect(toDisplayPath("/repo", "/repo")).toBe(".");
    expect(toDisplayPath("/outside/file.ts", "/repo")).toBe("/outside/file.ts");
  });

  test("getSandboxContext returns serializable sandbox context and working directory", () => {
    const context = getSandboxContext({
      sandbox: {
        state: { type: "vercel" },
        workingDirectory: "/repo",
      },
      model: "test-model",
    });

    expect(context.workingDirectory).toBe("/repo");
    expect(context.sandbox.workingDirectory).toBe("/repo");
  });

  test("getSandbox connects using the sandbox state from context", async () => {
    const sandbox = await getSandbox(
      {
        sandbox: {
          state: { type: "vercel", sandboxId: "sbx-456" },
          workingDirectory: "/repo",
        },
        model: "test-model",
      },
      "read",
    );

    expect(sandbox.workingDirectory).toBe("/repo");
    expect(connectSandboxCalls).toEqual([
      [{ type: "vercel", sandboxId: "sbx-456" }],
    ]);
  });

  test("getSandbox wraps the live sandbox with the security policy when present", async () => {
    // The "provider" sandbox is permissive — it would happily read any path.
    connectSandboxResult = {
      type: "docker",
      workingDirectory: "/repo",
      readFile: async () => "SUPER_SECRET",
      readFileBuffer: async () => Buffer.from(""),
      writeFile: async () => {},
      stat: async () => ({
        isDirectory: () => false,
        isFile: () => true,
        size: 0,
        mtimeMs: 0,
      }),
      access: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      exec: async () => ({
        success: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
      }),
      stop: async () => {},
    };

    const sandbox = await getSandbox(
      {
        sandbox: {
          state: { type: "vercel", sandboxId: "sbx-789" },
          workingDirectory: "/repo",
          securityPolicy: realSandboxModule.defaultSecurityPolicy("/repo"),
        },
        model: "test-model",
      },
      "read",
    );

    // Traversal is blocked at the boundary even though the inner sandbox
    // would have served the read.
    await expect(sandbox.readFile("../../etc/passwd", "utf-8")).rejects.toThrow(
      /policy violation/,
    );
    await expect(sandbox.exec("rm -rf /", "/repo", 100)).rejects.toThrow(
      /policy violation/,
    );
    // Legitimate reads still work.
    expect(await sandbox.readFile("src/index.ts", "utf-8")).toBe(
      "SUPER_SECRET",
    );
  });

  test("shellEscape safely escapes single quotes", () => {
    expect(shellEscape("simple")).toBe("'simple'");
    expect(shellEscape("it's fine")).toBe("'it'\\''s fine'");
  });
});
