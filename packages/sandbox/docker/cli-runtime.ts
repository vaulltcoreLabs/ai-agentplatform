import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ContainerRuntime,
  ExecOptions,
  FileStat,
  DockerExecError,
} from "./runtime.ts";
import type { ExecResult } from "../interface.ts";
import { SandboxProvisionError } from "../errors.ts";

const execFileAsync = promisify(execFile);

/**
 * Maximum buffer size for command output (bytes). If a command produces more
 * output than this, it is truncated in the result with `truncated: true`.
 * This prevents unbounded memory growth from runaway commands (fork bombs,
 * log flooding, etc.).
 */
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024; // 1 MB

/** Maximum buffer size before execFile rejects (2 MB — gives headroom for
 * capture before truncation applies). */
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

function truncateOutput(output: string): {
  output: string;
  truncated: boolean;
} {
  if (output.length <= MAX_OUTPUT_BYTES) {
    return { output, truncated: false };
  }
  return {
    output: output.slice(0, MAX_OUTPUT_BYTES),
    truncated: true,
  };
}

/**
 * Production `ContainerRuntime` backed by the Docker Engine CLI.
 * Lazily resolves the `docker` binary; only instantiated when a Docker
 * sandbox is actually connected/created.
 */
export class DockerCliRuntime implements ContainerRuntime {
  readonly id: string;
  readonly workingDirectory: string;

  constructor(params: {
    id: string;
    workingDirectory: string;
    image?: string;
  }) {
    this.id = params.id;
    this.workingDirectory = params.workingDirectory;
  }

  private docker(args: string[], options?: ExecOptions): Promise<ExecResult> {
    return execFileAsync("docker", args, {
      timeout: options?.timeoutMs,
      signal: options?.signal,
      maxBuffer: MAX_BUFFER_BYTES,
    })
      .then(({ stdout, stderr }) => {
        const out = truncateOutput(
          typeof stdout === "string"
            ? stdout
            : Buffer.from(stdout).toString("utf-8"),
        );
        const err = truncateOutput(
          typeof stderr === "string"
            ? stderr
            : Buffer.from(stderr).toString("utf-8"),
        );
        return {
          success: true,
          exitCode: 0,
          stdout: out.output,
          stderr: err.output,
          truncated: out.truncated || err.truncated,
        };
      })
      .catch((error: DockerExecError) => ({
        success: false,
        exitCode: typeof error.code === "number" ? error.code : null,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        truncated: false,
      }));
  }

  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const args = ["exec"];
    if (options?.cwd) {
      args.push("-w", options.cwd);
    }
    args.push(this.id, "sh", "-c", command);
    return this.docker(args, options);
  }

  async readFile(path: string): Promise<Buffer> {
    const { stdout } = await execFileAsync(
      "docker",
      ["cp", this.id + ":" + path, "-"],
      {
        maxBuffer: MAX_BUFFER_BYTES,
      },
    );
    return Buffer.isBuffer(stdout)
      ? stdout
      : Buffer.from(typeof stdout === "string" ? stdout : String(stdout));
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    if (content.length > MAX_OUTPUT_BYTES) {
      throw new SandboxProvisionError(
        `File content exceeds maximum allowed size (${MAX_OUTPUT_BYTES} bytes)`,
        { metadata: { path, size: content.length, max: MAX_OUTPUT_BYTES } },
      );
    }
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent) {
      await execFileAsync("docker", ["exec", this.id, "mkdir", "-p", parent]);
    }
    await execFileAsync("docker", ["cp", "-", this.id + ":" + path], {
      input: content,
      maxBuffer: MAX_BUFFER_BYTES,
    } as import("node:child_process").ExecFileOptions);
  }

  async mkdirp(path: string): Promise<void> {
    await execFileAsync("docker", ["exec", this.id, "mkdir", "-p", path]);
  }

  async listDirectory(path: string): Promise<string[]> {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      this.id,
      "ls",
      "-1",
      "-p",
      path || ".",
    ]);
    return stdout
      .split("\n")
      .map((line: string) => line.trim())
      .filter(Boolean);
  }

  async stat(path: string): Promise<FileStat> {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      this.id,
      "stat",
      "-c",
      "%s %F %a",
      path,
    ]);
    const [sizeStr, type, modeStr] = stdout.trim().split(" ");
    return {
      size: Number.parseInt(sizeStr ?? "0", 10) || 0,
      isDirectory: type === "directory",
      mode: Number.parseInt(modeStr ?? "0", 8) || 0,
      mtimeMs: 0,
    };
  }

  async stop(): Promise<void> {
    await execFileAsync("docker", ["rm", "-f", this.id]);
  }
}
