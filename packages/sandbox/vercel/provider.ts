import type { Sandbox } from "../interface.ts";
import type {
  ConnectOptions,
  CreateSandboxRequest,
  SandboxProvider,
  SandboxProviderType,
  SandboxState,
  VercelSandboxState,
} from "../provider.ts";
import type { VercelState } from "./state.ts";
import { connectVercel } from "./connect.ts";
import { SandboxProviderError } from "../errors.ts";

function isVercelState(state: SandboxState): state is VercelSandboxState {
  return state.type === "vercel" || state.type === "cloud";
}

/**
 * `SandboxProvider` for the Vercel-backed cloud sandbox. The Agent Engine
 * depends only on the `Sandbox` contract; this adapter is lazy-loaded by
 * `ensureDefaultProviders` so the `@vercel/sandbox` SDK stays out of the
 * hot path.
 */
export class VercelSandboxProvider implements SandboxProvider {
  readonly type: SandboxProviderType = "vercel";

  async connect(
    state: SandboxState,
    options?: ConnectOptions,
  ): Promise<Sandbox> {
    if (!isVercelState(state)) {
      throw new SandboxProviderError(
        `Vercel provider cannot connect to state of type '${state.type}'.`,
        { metadata: { provider: "vercel", stateType: state.type } },
      );
    }

    const vercelState: VercelState = {
      source: state.source,
      sandboxName: state.sandboxName,
      sandboxId: state.sandboxId,
      snapshotId: state.snapshotId,
      expiresAt: state.expiresAt,
    };

    return connectVercel(vercelState, options);
  }

  async create(request: CreateSandboxRequest): Promise<Sandbox> {
    const vercelState: VercelState = {
      ...(request.sandboxName ? { sandboxName: request.sandboxName } : {}),
      ...(request.source ? { source: request.source } : {}),
    };

    return connectVercel(vercelState, {
      ...request.options,
      createIfMissing: true,
    });
  }
}

export const vercelSandboxProvider = new VercelSandboxProvider();
