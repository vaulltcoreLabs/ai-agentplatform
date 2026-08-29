import type { Sandbox, SandboxHooks } from "./interface.ts";
import type { DockerSandboxState } from "./docker/state.ts";
import type { VercelState } from "./vercel/state.ts";
import type { FileEntry, Source } from "./types.ts";
import { SandboxProviderError } from "./errors.ts";

/**
 * Discriminator key for sandbox state objects. These keys drive
 * `connectSandbox` / `createSandbox` dispatch.
 */
export type SandboxProviderType = "vercel" | "docker";

/**
 * State for connecting to / creating a Vercel-backed sandbox.
 */
export type VercelSandboxState = { type: "vercel" | "cloud" } & VercelState;

/**
 * Options accepted when connecting to or creating a sandbox.
 * Mirrors the legacy per-provider option shapes so existing call sites
 * (e.g. `connectSandbox({ state, options })`) remain valid.
 */
export interface ConnectOptions {
  env?: Record<string, string>;
  githubToken?: string;
  gitUser?: { name: string; email: string };
  hooks?: SandboxHooks;
  timeout?: number;
  vcpus?: number;
  ports?: number[];
  baseSnapshotId?: string;
  resume?: boolean;
  createIfMissing?: boolean;
  persistent?: boolean;
  snapshotExpiration?: number;
  skipGitWorkspaceBootstrap?: boolean;
}

/**
 * Request to create a brand-new sandbox via a named provider.
 */
export interface CreateSandboxRequest {
  /** Which provider to route creation to (e.g. "vercel", "docker"). */
  provider: SandboxProviderType;
  sandboxName?: string;
  source?: Source;
  image?: string;
  options?: ConnectOptions;
}

/**
 * Discriminated union of all concrete sandbox states. Each member's
 * `type` drives provider dispatch.
 */
export type SandboxState = VercelSandboxState | DockerSandboxState;

/**
 * A provider implementation for a concrete sandbox backend.
 *
 * `connect` accepts the *full* `SandboxState` union and narrows by
 * `state.type`, so a provider is free to throw `SandboxProviderError`
 * for states it does not own.
 */
export interface SandboxProvider {
  readonly type: SandboxProviderType;
  connect(state: SandboxState, options?: ConnectOptions): Promise<Sandbox>;
  create?(request: CreateSandboxRequest): Promise<Sandbox>;
}

/**
 * Registry mapping a `SandboxProviderType` to its `SandboxProvider`.
 *
 * The Agent Engine only ever talks to this registry (via
 * `connectSandbox`/`createSandbox`); provider implementations and their
 * SDK imports stay out of the hot path.
 */
export class SandboxProviderRegistry {
  readonly #providers = new Map<SandboxProviderType, SandboxProvider>();

  /**
   * Register (or replace) a provider for a given type.
   * Throws if a provider for `type` is already registered, to surface
   * accidental double-registration during lazy loading.
   */
  register(provider: SandboxProvider): void {
    if (this.#providers.has(provider.type)) {
      throw new SandboxProviderError(
        `A provider for sandbox type '${provider.type}' is already registered.`,
        { metadata: { provider: provider.type } },
      );
    }
    this.#providers.set(provider.type, provider);
  }

  has(type: SandboxProviderType): boolean {
    return this.#providers.has(type);
  }

  get(type: SandboxProviderType): SandboxProvider {
    const provider = this.#providers.get(type);
    if (!provider) {
      throw new SandboxProviderError(
        `No sandbox provider registered for type '${type}'.`,
        { metadata: { provider: type } },
      );
    }
    return provider;
  }

  connect(state: SandboxState, options?: ConnectOptions): Promise<Sandbox> {
    const provider = this.get(state.type as SandboxProviderType);
    return provider.connect(state, options);
  }

  create(request: CreateSandboxRequest): Promise<Sandbox> {
    const provider = this.get(request.provider);
    if (!provider.create) {
      throw new SandboxProviderError(
        `Sandbox provider '${request.provider}' does not support creation.`,
        { metadata: { provider: request.provider } },
      );
    }
    return provider.create(request);
  }
}

/**
 * Lazy singleton registry. Providers are loaded on first use via
 * dynamic imports so their SDK dependencies are not pulled into the
 * Agent Engine until actually needed.
 */
let defaultRegistry: SandboxProviderRegistry | null = null;

export function getDefaultRegistry(): SandboxProviderRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new SandboxProviderRegistry();
  }
  return defaultRegistry;
}

/**
 * Reset the singleton (primarily for tests).
 */
export function resetDefaultRegistry(): void {
  defaultRegistry = null;
}

/**
 * Ensure the default registry has the built-in providers registered.
 *
 * Providers are imported lazily (and wrapped in try/catch) so a missing
 * optional backend (e.g. Docker tooling absent in CI) does not break the
 * Vercel path. Registering a provider must be side-effect free — no
 * runtime spawning of the underlying tool.
 */
export async function ensureDefaultProviders(): Promise<SandboxProviderRegistry> {
  const registry = getDefaultRegistry();

  if (!registry.has("vercel")) {
    try {
      const { vercelSandboxProvider } = await import("./vercel/provider.ts");
      registry.register(vercelSandboxProvider);
    } catch (error) {
      // Vercel provider unavailable — leave unregistered for now.
      void error;
    }
  }

  if (!registry.has("docker")) {
    try {
      const { dockerSandboxProvider } = await import("./docker/provider.ts");
      registry.register(dockerSandboxProvider);
    } catch (error) {
      void error;
    }
  }

  return registry;
}

// Re-export a few helpers so providers and consumers share one shape.
export type { FileEntry, Source };
