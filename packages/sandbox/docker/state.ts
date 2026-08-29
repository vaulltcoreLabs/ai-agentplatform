import type { Source } from "../types.ts";

/**
 * State configuration for connecting to or creating a Docker-backed sandbox.
 * `type` discriminates this member within `SandboxState`.
 */
export interface DockerSandboxState {
  type: "docker";
  /** Durable container name (optional; generated if absent). */
  sandboxName?: string;
  /** Optional repository to clone into the container on start. */
  source?: Source;
  /** Container image to run. */
  image?: string;
}

/**
 * Build a normalized `DockerSandboxState` from looser input.
 */
export function buildDockerState(params: {
  sandboxName?: string;
  source?: Source;
  image?: string;
}): DockerSandboxState {
  return {
    type: "docker",
    ...(params.sandboxName ? { sandboxName: params.sandboxName } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.image ? { image: params.image } : {}),
  };
}
