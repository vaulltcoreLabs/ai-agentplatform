import { afterEach, describe, expect, test } from "bun:test";
import {
  SandboxCapabilityError,
  SandboxNotFoundError,
  SandboxProvisionError,
  SandboxProviderError,
  type CreateSandboxRequest,
  type Sandbox,
  type SandboxProvider,
  type SandboxProviderType,
  type SandboxState,
  SandboxProviderRegistry,
  connectSandbox,
  createSandbox,
  ensureDefaultProviders,
  getDefaultRegistry,
  resetDefaultRegistry,
} from "./index";
import { withTemporaryGitHubAuth } from "./git";

afterEach(() => {
  resetDefaultRegistry();
});

function fakeSandbox(): Sandbox {
  return {
    type: "cloud",
    workingDirectory: "/repo",
    readFile: async () => "",
    readFileBuffer: async () => Buffer.from(""),
    writeFile: async () => {},
    stat: async () => ({
      isDirectory: () => true,
      isFile: () => false,
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
  } as unknown as Sandbox;
}

function makeProvider(
  type: SandboxProviderType,
  connect: (state: SandboxState, options?: unknown) => Promise<Sandbox>,
  create?: (request: CreateSandboxRequest) => Promise<Sandbox>,
): SandboxProvider {
  const provider: SandboxProvider = { type, connect };
  if (create) {
    provider.create = create;
  }
  return provider;
}

describe("provider registry", () => {
  test("ensureDefaultProviders registers vercel and docker without spawning", async () => {
    resetDefaultRegistry();
    const registry = await ensureDefaultProviders();
    expect(registry.has("vercel")).toBe(true);
    expect(registry.has("docker")).toBe(true);
  });

  test("register throws on duplicate type", () => {
    resetDefaultRegistry();
    const registry = getDefaultRegistry();
    registry.register(makeProvider("vercel", async () => fakeSandbox()));
    expect(() =>
      registry.register(makeProvider("vercel", async () => fakeSandbox())),
    ).toThrow(SandboxProviderError);
  });

  test("get throws for an unregistered type", () => {
    const registry = new SandboxProviderRegistry();
    expect(() => registry.get("docker")).toThrow(SandboxProviderError);
  });

  test("connect throws for an unregistered provider", () => {
    const registry = new SandboxProviderRegistry();
    expect(() =>
      registry.connect({ type: "docker", sandboxName: "x" }),
    ).toThrow(SandboxProviderError);
  });

  test("create throws when the provider has no create", () => {
    const registry = new SandboxProviderRegistry();
    registry.register(makeProvider("vercel", async () => fakeSandbox()));
    expect(() =>
      registry.create({ provider: "vercel", sandboxName: "x" }),
    ).toThrow(SandboxProviderError);
  });
});

describe("connectSandbox dispatch", () => {
  test("routes a bare state to the registered provider", async () => {
    resetDefaultRegistry();
    const captured: { state: SandboxState | null } = { state: null };
    getDefaultRegistry().register(
      makeProvider("vercel", async (state) => {
        captured.state = state;
        return fakeSandbox();
      }),
    );

    const state: SandboxState = { type: "vercel", sandboxName: "demo" };
    const sandbox = await connectSandbox(state);

    expect(captured.state).toEqual(state);
    expect(sandbox).toBeInstanceOf(Object);
  });

  test("forwards options through the {state, options} envelope", async () => {
    resetDefaultRegistry();
    const captured: { options: unknown } = { options: undefined };
    getDefaultRegistry().register(
      makeProvider("vercel", async (_state, options) => {
        captured.options = options;
        return fakeSandbox();
      }),
    );

    const state: SandboxState = { type: "vercel", sandboxName: "demo" };
    await connectSandbox({ state, options: { timeout: 123 } });
    expect(captured.options).toEqual({ timeout: 123 });
  });

  test("normalizes the legacy 'cloud' type alias to vercel", async () => {
    resetDefaultRegistry();
    const captured: { state: SandboxState | null } = { state: null };
    getDefaultRegistry().register(
      makeProvider("vercel", async (state) => {
        captured.state = state;
        return fakeSandbox();
      }),
    );

    const sandbox = await connectSandbox({
      type: "cloud",
      sandboxName: "demo",
    });
    expect(sandbox).toBeInstanceOf(Object);
    // The original state object retains its legacy type tag.
    expect(captured.state).not.toBeNull();
    expect(captured.state!.type).toBe("cloud");
  });

  test("throws SandboxProviderError for an unregistered provider type", async () => {
    resetDefaultRegistry();
    const state = { type: "unknown" } as unknown as SandboxState;
    await expect(connectSandbox(state)).rejects.toThrow(SandboxProviderError);
  });
});

describe("createSandbox dispatch", () => {
  test("routes creation to the registered provider.create", async () => {
    resetDefaultRegistry();
    let seen: unknown;
    getDefaultRegistry().register({
      type: "vercel",
      connect: async () => fakeSandbox(),
      create: async (request) => {
        seen = request;
        return fakeSandbox();
      },
    });

    const sandbox = await createSandbox({
      provider: "vercel",
      sandboxName: "fresh",
    });
    expect(sandbox.type).toBe("cloud");
    expect(seen).toEqual({ provider: "vercel", sandboxName: "fresh" });
  });

  test("throws when the provider has no create", async () => {
    resetDefaultRegistry();
    getDefaultRegistry().register(
      makeProvider("vercel", async () => fakeSandbox()),
    );
    await expect(
      createSandbox({ provider: "vercel", sandboxName: "x" }),
    ).rejects.toThrow(SandboxProviderError);
  });
});

describe("fail-safe auth", () => {
  test("withTemporaryGitHubAuth runs the operation when the sandbox has no broker", async () => {
    const sandbox = fakeSandbox();
    const result = await withTemporaryGitHubAuth(
      sandbox,
      "secret",
      async () => "ran",
    );
    expect(result).toBe("ran");
    expect(
      (sandbox as unknown as { setGitHubAuthToken?: unknown })
        .setGitHubAuthToken,
    ).toBeUndefined();
  });
});

describe("capability errors", () => {
  test("SandboxCapabilityError is a SandboxError subclass", () => {
    const err = new SandboxCapabilityError("nope");
    expect(err).toBeInstanceOf(SandboxCapabilityError);
    expect(err.name).toBe("SandboxCapabilityError");
  });

  test("SandboxNotFoundError name", () => {
    expect(new SandboxNotFoundError("gone").name).toBe("SandboxNotFoundError");
  });

  test("SandboxProvisionError carries metadata", () => {
    const err = new SandboxProvisionError("bad", { metadata: { code: 1 } });
    expect((err.metadata as { code: number }).code).toBe(1);
  });
});
