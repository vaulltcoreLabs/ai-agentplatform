/**
 * Vaulltcore Agent Engine — model provider resolution.
 *
 * Boundary:
 *
 *   CredentialResolver  →  ModelResolver  →  LanguageModel
 *
 * The engine never stores credentials and never cares where a credential came
 * from (Vaulltcore-managed, BYOK, future self-hosted). It only passes a
 * `ModelSelection` and receives a provider-neutral `LanguageModel`.
 *
 * OpenAI is a first-class Vaulltcore-supported provider (not an accidental
 * dependency): it is one of the adapters selectable through `ModelSelection`.
 */

import type { LanguageModel } from "ai";
import type { ModelProvider } from "./capabilities";
import { parseProvider } from "./capabilities";
import {
  gateway,
  type GatewayModelId,
  type ProviderOptionsByProvider,
} from "../models";

export interface ModelRuntimeConfig {
  providerOptions?: ProviderOptionsByProvider;
  temperature?: number;
  maxSteps?: number;
}

/**
 * Provider-neutral description of the model the engine should use. The engine
 * passes this to a `ModelResolver` and receives a `LanguageModel` — it never
 * constructs provider clients itself.
 */
export interface ModelSelection {
  /** Resolved provider (anthropic/openai/google/unknown). */
  provider: ModelProvider;
  /** Model id, e.g. "anthropic/claude-opus-4.6" or "openai/gpt-5". */
  model: string;
  /**
   * Opaque reference to credentials. The engine never sees the secret; the
   * `CredentialResolver` fetches it. Absent = Vaulltcore-managed model.
   */
  credentialRef?: string;
  runtimeConfig?: ModelRuntimeConfig;
}

/**
 * Resolved credential material. Returned only transiently inside the resolver;
 * never stored on the engine and never passed into tools or the sandbox.
 */
export interface ResolvedCredential {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

/**
 * Fetches credentials for a `credentialRef`. Implementations may read from a
 * secret vault, environment, or future BYOK store. This engine ships a managed
 * resolver that returns `undefined` (Vaulltcore supplies credentials at the
 * gateway). Credential storage is intentionally NOT implemented here (Phase 4+).
 */
export interface CredentialResolver {
  resolve(ref: string): ResolvedCredential | undefined;
}

export type ModelResolver = (selection: ModelSelection) => LanguageModel;

export const managedCredentialResolver: CredentialResolver = {
  resolve: () => undefined,
};

export function parseModelSelection(
  input: string | ModelSelection,
): ModelSelection {
  if (typeof input === "string") {
    return { provider: parseProvider(input), model: input };
  }
  return input;
}

export interface CreateModelResolverOptions {
  /** Override the gateway used to build models (tests inject mocks here). */
  gateway?: typeof gateway;
  credentialResolver?: CredentialResolver;
}

/**
 * Default resolver: maps a `ModelSelection` to a `LanguageModel` via the
 * existing provider-neutral gateway. Credentials are resolved through the
 * injected `CredentialResolver` and only ever reach the provider adapter — they
 * are never exposed to the engine surface, tools, or sandbox.
 */
export function createModelResolver(
  options: CreateModelResolverOptions = {},
): ModelResolver {
  const gatewayFn = options.gateway ?? gateway;
  const credentials = options.credentialResolver ?? managedCredentialResolver;

  return (selection: ModelSelection): LanguageModel => {
    const resolved = selection.credentialRef
      ? credentials.resolve(selection.credentialRef)
      : undefined;

    const config = resolved
      ? {
          baseURL: resolved.baseURL ?? "",
          apiKey: resolved.apiKey ?? "",
          ...(resolved.headers ? { headers: resolved.headers } : {}),
        }
      : undefined;

    return gatewayFn(selection.model as GatewayModelId, {
      config,
      providerOptionsOverrides: selection.runtimeConfig?.providerOptions,
    });
  };
}
