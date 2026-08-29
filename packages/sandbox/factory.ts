import type { Sandbox, SandboxHooks, SandboxType } from "./interface.ts";
import { SandboxProviderError } from "./errors.ts";
import {
  ensureDefaultProviders,
  type ConnectOptions,
  type CreateSandboxRequest,
  type SandboxProvider,
  type SandboxProviderRegistry,
  type SandboxProviderType,
  type SandboxState,
} from "./provider.ts";

export type {
  SandboxState,
  ConnectOptions,
  CreateSandboxRequest,
  SandboxProvider,
  SandboxProviderRegistry,
  SandboxProviderType,
} from "./provider.ts";

export {
  ensureDefaultProviders,
  getDefaultRegistry,
  resetDefaultRegistry,
} from "./provider.ts";

export { SandboxProviderError } from "./errors.ts";

/**
 * Configuration for connecting to a sandbox using the new
 * `{ state, options }` envelope.
 */
export type SandboxConnectConfig = {
  state: SandboxState;
  options?: ConnectOptions;
};

// Re-export SandboxType/SandboxHooks for consumers building configs.
export type { SandboxType, SandboxHooks };

function isConnectConfig(value: unknown): value is SandboxConnectConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybe = value as { state?: unknown };
  if (typeof maybe.state !== "object" || maybe.state === null) {
    return false;
  }
  return "type" in maybe.state;
}

/**
 * Resolve a sandbox state's provider type, treating the legacy `"cloud"`
 * alias as `"vercel"` so existing call sites keep working.
 */
function toProviderType(state: SandboxState): SandboxProviderType {
  return state.type === "cloud"
    ? "vercel"
    : (state.type as SandboxProviderType);
}

/**
 * Connect to a sandbox using the provider indicated by `state.type`.
 *
 * Accepts either:
 *  - `connectSandbox({ state, options })` (preferred envelope form), or
 *  - `connectSandbox(state, legacyOptions)` (legacy bare-state form).
 *
 * This is the single entry point the Agent Engine and application code
 * use. No application code directly imports a concrete provider.
 */
export async function connectSandbox(
  configOrState: SandboxConnectConfig | SandboxState,
  legacyOptions?: ConnectOptions,
): Promise<Sandbox> {
  const registry: SandboxProviderRegistry = await ensureDefaultProviders();

  const config: SandboxConnectConfig = isConnectConfig(configOrState)
    ? configOrState
    : { state: configOrState as SandboxState, options: legacyOptions };

  const { state, options } = config;
  const providerType = toProviderType(state);

  if (!registry.has(providerType)) {
    throw new SandboxProviderError(
      `Unsupported or unregistered sandbox provider '${state.type}'.`,
      { metadata: { provider: state.type } },
    );
  }

  return registry.get(providerType).connect(state, options);
}

/**
 * Create a brand-new sandbox via the factory, selecting the provider by name.
 * Keeps the Agent Engine free of provider imports.
 */
export async function createSandbox(
  request: CreateSandboxRequest,
): Promise<Sandbox> {
  const registry: SandboxProviderRegistry = await ensureDefaultProviders();

  if (!registry.has(request.provider)) {
    throw new SandboxProviderError(
      `Unsupported or unregistered sandbox provider '${request.provider}'.`,
      { metadata: { provider: request.provider } },
    );
  }

  return registry.create(request);
}
