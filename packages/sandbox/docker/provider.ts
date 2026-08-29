import type { Sandbox } from "../interface.ts";
import type {
  ConnectOptions,
  CreateSandboxRequest,
  SandboxProvider,
  SandboxProviderType,
  SandboxState,
} from "../provider.ts";
import { SandboxProvisionError } from "../errors.ts";
import { DockerSandbox, type DockerSandboxConfig } from "./sandbox.ts";
import { DockerCliRuntime } from "./runtime.ts";
import type { DockerSandboxState } from "./state.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isDockerState(state: SandboxState): state is DockerSandboxState {
  return state.type === "docker";
}

function toConfig(
  state: DockerSandboxState,
  options?: ConnectOptions,
): DockerSandboxConfig {
  return {
    name: state.sandboxName ?? "docker-sandbox",
    workingDirectory: "/workspace",
    ...(state.image ? { image: state.image } : {}),
    env: options?.env,
    source: state.source,
    timeout: options?.timeout,
    hooks: options?.hooks,
  };
}

async function createRuntimeContainer(
  config: DockerSandboxConfig,
): Promise<{ id: string; workingDirectory: string }> {
  const args = ["run", "-d", "--name", config.name];
  if (config.image) {
    args.push(config.image);
  } else {
    args.push("ubuntu:latest");
  }
  // Keep the container alive.
  args.push("tail", "-f", "/dev/null");
  const { stdout } = await execFileAsync("docker", args);
  const id = stdout.trim();
  return { id, workingDirectory: config.workingDirectory };
}

/** `SandboxProvider` for the Docker backend. */
export class DockerSandboxProvider implements SandboxProvider {
  readonly type: SandboxProviderType = "docker";

  async connect(
    state: SandboxState,
    options?: ConnectOptions,
  ): Promise<Sandbox> {
    if (!isDockerState(state)) {
      throw new SandboxProvisionError(
        `Docker provider cannot connect to state of type '${state.type}'.`,
        { metadata: { provider: "docker", stateType: state.type } },
      );
    }

    const config = toConfig(state, options);

    if (state.sandboxName) {
      try {
        await execFileAsync("docker", ["start", state.sandboxName]);
      } catch (error) {
        throw new SandboxProvisionError(
          `Failed to start Docker sandbox '${state.sandboxName}': ${(error as Error).message}`,
          { metadata: { sandbox: state.sandboxName } },
        );
      }
    } else {
      const container = await createRuntimeContainer(config);
      return new DockerSandbox({
        runtime: new DockerCliRuntime({
          id: container.id,
          workingDirectory: container.workingDirectory,
          image: config.image,
        }),
        config,
      });
    }

    return new DockerSandbox({
      runtime: new DockerCliRuntime({
        id: state.sandboxName,
        workingDirectory: config.workingDirectory,
        image: config.image,
      }),
      config,
    });
  }

  async create(request: CreateSandboxRequest): Promise<Sandbox> {
    const state: DockerSandboxState = {
      type: "docker",
      sandboxName: request.sandboxName,
      ...(request.source ? { source: request.source } : {}),
      ...(request.image ? { image: request.image } : {}),
    };
    const config = toConfig(state, request.options);
    const container = await createRuntimeContainer(config);
    const sandbox = new DockerSandbox({
      runtime: new DockerCliRuntime({
        id: container.id,
        workingDirectory: container.workingDirectory,
        image: config.image,
      }),
      config,
    });
    await request.options?.hooks?.afterStart?.(sandbox);
    return sandbox;
  }
}

export const dockerSandboxProvider = new DockerSandboxProvider();
