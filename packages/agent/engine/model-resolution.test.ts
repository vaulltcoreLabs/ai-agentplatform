import { describe, expect, it } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import {
  createModelResolver,
  managedCredentialResolver,
  parseModelSelection,
  type CredentialResolver,
} from "./model-resolution";

const mockModel = new MockLanguageModelV3() as unknown as LanguageModel;

describe("model resolution (provider-neutral)", () => {
  it("managed credentials resolve to undefined (Vaulltcore supplies them)", () => {
    expect(managedCredentialResolver.resolve("any-ref")).toBeUndefined();
  });

  it("resolves a model through an injected gateway without using the real Vercel gateway", () => {
    const resolver = createModelResolver({ gateway: () => mockModel });
    const model = resolver({
      provider: "anthropic",
      model: "anthropic/claude-opus-4.6",
    });
    expect(model).toBe(mockModel);
  });

  it("passes BYOK credentials to the gateway as resolved config, never storing them", () => {
    let captured:
      | { id: string; config?: { apiKey: string; baseURL: string } }
      | undefined;
    const byok: CredentialResolver = {
      resolve: (ref) =>
        ref === "user-1"
          ? { apiKey: "sk-byok", baseURL: "https://byok.example" }
          : undefined,
    };
    const resolver = createModelResolver({
      gateway: ((
        id: string,
        opts?: { config?: { apiKey: string; baseURL: string } },
      ) => {
        captured = { id, config: opts?.config };
        return mockModel;
      }) as never,
      credentialResolver: byok,
    });

    resolver({
      provider: "openai",
      model: "openai/gpt-5",
      credentialRef: "user-1",
    });

    expect(captured?.id).toBe("openai/gpt-5");
    expect(captured?.config?.apiKey).toBe("sk-byok");
    expect(captured?.config?.baseURL).toBe("https://byok.example");
  });

  it("normalizes a model-id string into a selection", () => {
    const selection = parseModelSelection("openai/gpt-5");
    expect(selection.provider).toBe("openai");
    expect(selection.model).toBe("openai/gpt-5");
  });
});
