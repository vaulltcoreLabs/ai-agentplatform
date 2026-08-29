import type { Dirent } from "fs";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
  SnapshotResult,
} from "../interface.ts";
import { SandboxCapabilityError, SandboxNotFoundError } from "../errors.ts";
import type { ContainerRuntime } from "./runtime.ts";
import type { DockerSandboxState } from "./state.ts";
import type { Source } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface DockerSandboxConfig {
  readonly name: string;
  readonly workingDirectory: string;
  readonly image?: string;
  readonly env?: Record<string, string>;
  readonly source?: Source;
  readonly timeout?: number;
  readonly hooks?: SandboxHooks;
}

/**
 * `Sandbox` implementation backed by a Docker container whose lifecycle and
 * I/O are mediated by a `ContainerRuntime`. Tests inject a
 * `MemoryContainerRuntime`; production uses `DockerCliRuntime`.
 */
export class DockerSandbox implements Sandbox {
  readonly type = "docker" as const;
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  readonly currentBranch?: string;
  readonly hooks?: SandboxHooks;
  readonly environmentDetails?: string;
  readonly host?: string;
  readonly expiresAt?: number;
  readonly timeout?: number;

  private readonly runtime: ContainerRuntime;
  private readonly config: DockerSandboxConfig;
  private stopped = false;
  private readonly _createdAt: number;

  constructor(params: {
    runtime: ContainerRuntime;
    config: DockerSandboxConfig;
  }) {
    this.runtime = params.runtime;
    this.config = params.config;
    this.workingDirectory =
      params.runtime.workingDirectory || params.config.workingDirectory;
    this.env = params.config.env;
    this.hooks = params.config.hooks;
    this.timeout = params.config.timeout;
    this.environmentDetails = `Docker container ${params.config.name}`;
    this.host = "localhost";
    this._createdAt = Date.now();
  }

  #checkAlive(): void {
    if (this.stopped) {
      throw new SandboxNotFoundError("Docker sandbox has been stopped");
    }
  }

  async readFile(path: string, _encoding: "utf-8"): Promise<string> {
    this.#checkAlive();
    const buf = await this.runtime.readFile(path);
    return buf.toString("utf-8");
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    this.#checkAlive();
    return this.runtime.readFile(path);
  }

  async writeFile(
    path: string,
    content: string,
    _encoding: "utf-8",
  ): Promise<void> {
    this.#checkAlive();
    await this.runtime.writeFile(path, Buffer.from(content, "utf-8"));
  }

  async stat(path: string): Promise<SandboxStats> {
    this.#checkAlive();
    const stat = await this.runtime.stat(path);
    return {
      isDirectory: () => stat.isDirectory,
      isFile: () => !stat.isDirectory,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }

  async access(path: string): Promise<void> {
    this.#checkAlive();
    await this.runtime.stat(path);
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    this.#checkAlive();
    await this.runtime.mkdirp(path);
  }

  async readdir(
    path: string,
    _options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    this.#checkAlive();
    const names = await this.runtime.listDirectory(path);
    const entries: Dirent[] = [];
    for (const name of names) {
      const fullPath = path.endsWith("/") ? path + name : path + "/" + name;
      let isDir = false;
      try {
        const stat = await this.runtime.stat(fullPath);
        isDir = stat.isDirectory;
      } catch {
        isDir = false;
      }
      entries.push({
        name,
        parentPath: path,
        path: fullPath,
        isDirectory: () => isDir,
        isFile: () => !isDir,
        isSymbolicLink: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      } as Dirent);
    }
    return entries;
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    this.#checkAlive();
    return this.runtime.exec(command, {
      cwd,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options?.signal,
    });
  }

  /** Docker sandboxes do not expose a public preview domain. */
  domain(_port: number): string {
    throw new SandboxCapabilityError(
      "Docker sandboxes do not expose a public domain",
      { metadata: { sandbox: this.config.name } },
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await this.runtime.stop();
  }

  /** Docker sandboxes do not support native snapshots. */
  async snapshot(): Promise<SnapshotResult> {
    throw new SandboxCapabilityError(
      "Docker sandboxes do not support snapshots",
      { metadata: { sandbox: this.config.name } },
    );
  }

  /**
   * Serializable state allowing a Docker sandbox to be reconnected via
   * `connectSandbox` later.
   */
  getState(): DockerSandboxState {
    return {
      type: "docker",
      sandboxName: this.config.name,
      ...(this.config.image ? { image: this.config.image } : {}),
      ...(this.config.source ? { source: this.config.source } : {}),
    };
  }
}
