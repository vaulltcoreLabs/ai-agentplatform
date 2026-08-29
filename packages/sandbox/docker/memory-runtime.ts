import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import type { ContainerRuntime, ExecOptions, FileStat } from "./runtime.ts";
import type { ExecResult } from "../interface.ts";
import { SandboxProvisionError } from "../errors.ts";

function normalizePath(workingDirectory: string, path: string): string {
  if (resolve(path) === path || path.startsWith("/")) {
    return path;
  }
  return resolve(workingDirectory, path);
}

/**
 * In-memory `ContainerRuntime` used by the test suite. Provides a real
 * in-memory filesystem and an injectable `exec` implementation so tests
 * can assert on captured commands and synthesized results.
 */
export class MemoryContainerRuntime implements ContainerRuntime {
  readonly id: string;
  readonly workingDirectory: string;
  readonly #files = new Map<string, Buffer>();
  readonly #execImpl: (
    command: string,
    options?: ExecOptions,
  ) => Promise<ExecResult>;

  constructor(params: {
    id: string;
    workingDirectory: string;
    exec?: (command: string, options?: ExecOptions) => Promise<ExecResult>;
    files?: Record<string, string | Buffer>;
  }) {
    this.id = params.id;
    this.workingDirectory = params.workingDirectory;
    this.#execImpl =
      params.exec ??
      (() => {
        throw new SandboxProvisionError(
          "MemoryContainerRuntime: no exec implementation provided",
        );
      });
    for (const [key, value] of Object.entries(params.files ?? {})) {
      this.#files.set(
        normalizePath(this.workingDirectory, key),
        typeof value === "string" ? Buffer.from(value) : value,
      );
    }
  }

  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return this.#execImpl(command, options);
  }

  async readFile(path: string): Promise<Buffer> {
    const buf = this.#files.get(normalizePath(this.workingDirectory, path));
    if (!buf) {
      throw new Error(`File not found: ${path}`);
    }
    return buf;
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    this.#files.set(normalizePath(this.workingDirectory, path), content);
  }

  async mkdirp(path: string): Promise<void> {
    this.#files.set(
      normalizePath(this.workingDirectory, path),
      Buffer.alloc(0),
    );
  }

  async listDirectory(path: string): Promise<string[]> {
    const base = normalizePath(this.workingDirectory, path);
    const entries = new Set<string>();
    for (const key of this.#files.keys()) {
      if (key.startsWith(base + "/")) {
        entries.add(key.slice(base.length + 1).split("/")[0] ?? "");
      }
    }
    return Array.from(entries);
  }

  async stat(path: string): Promise<FileStat> {
    const buf = this.#files.get(normalizePath(this.workingDirectory, path));
    if (!buf) {
      throw new Error(`File not found: ${path}`);
    }
    return {
      size: buf.length,
      isDirectory: buf.length === 0,
      mode: 0o644,
      mtimeMs: 0,
    };
  }

  async stop(): Promise<void> {
    this.#files.clear();
  }
}
