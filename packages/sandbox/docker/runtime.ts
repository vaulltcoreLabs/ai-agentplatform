import type { ExecResult } from "../interface.ts";

/**
 * Options accepted by `ContainerRuntime.exec`. Mirrors the shape the
 * `Sandbox.exec` implementation forwards.
 */
export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A lightweight file stat used by the container runtimes. */
export interface FileStat {
  size: number;
  isDirectory: boolean;
  mode: number;
  mtimeMs: number;
}

/**
 * Shape of a rejected `docker` CLI invocation as surfaced by `execFile`.
 */
export interface DockerExecError {
  code?: number;
  stdout?: string;
  stderr?: string;
  signal?: string;
  killed?: boolean;
}

/**
 * Pluggable execution + filesystem backend for a sandbox. Decoupling the
 * `Sandbox` interface implementation from the transport lets us run tests
 * against an in-memory runtime (`MemoryContainerRuntime`) and production
 * against the Docker CLI (`DockerCliRuntime`) without mocks.
 */
export interface ContainerRuntime {
  /** Monotonic container id used for logging/identity. */
  readonly id: string;
  /** Absolute working directory inside the container. */
  readonly workingDirectory: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  mkdirp(path: string): Promise<void>;
  listDirectory(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  stop(): Promise<void>;
}

export { MemoryContainerRuntime } from "./memory-runtime.ts";
export { DockerCliRuntime } from "./cli-runtime.ts";
