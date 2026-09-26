import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderSettings } from "./config.js";
import type { FetchLike } from "./transport.js";

const DEFAULT_BASE_URLS: Partial<Record<ProviderSettings["kind"], string>> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};

/** Base URL a provider calls, or a reason it can't be determined. */
export function providerBaseUrl(provider: ProviderSettings): { url: string } | { problem: string } {
  if (provider.baseUrl) return { url: provider.baseUrl };
  const known = DEFAULT_BASE_URLS[provider.kind];
  if (known) return { url: known };
  const options = provider.options ?? {};
  if (provider.kind === "azure") {
    return options.resourceName
      ? { url: `https://${options.resourceName}.openai.azure.com/openai` }
      : { problem: "azure needs options.resourceName or baseUrl" };
  }
  if (provider.kind === "bedrock") {
    return options.region
      ? { url: `https://bedrock-runtime.${options.region}.amazonaws.com` }
      : { problem: "bedrock needs options.region or baseUrl" };
  }
  return { problem: `${provider.kind} needs a baseUrl` };
}

/** Kinds that can run without a key (local servers such as Ollama, vLLM, LM Studio). */
export const keyOptional = (provider: ProviderSettings) => provider.kind === "openai-compatible";

type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** Drops undefined settings (the SDKs' option types don't accept explicit undefined). */
function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Defined<T>;
}

/**
 * Builds the AI SDK model for one pool entry. Every provider gets the guarded
 * fetch; no provider is ever created without an explicit key (so SDK env-var
 * fallbacks never kick in), except key-optional local servers.
 */
export function createLanguageModel(
  id: string,
  provider: ProviderSettings,
  model: string,
  apiKey: string | undefined,
  fetch: FetchLike,
): LanguageModel {
  const baseURL = provider.baseUrl;
  const options = provider.options ?? {};
  switch (provider.kind) {
    case "anthropic":
      return createAnthropic(defined({ apiKey, baseURL, fetch }))(model);
    case "openai":
      return createOpenAI(defined({ apiKey, baseURL, fetch }))(model);
    case "google":
      return createGoogle(defined({ apiKey, baseURL, fetch }))(model);
    case "azure":
      return createAzure(
        defined({
          apiKey,
          baseURL,
          fetch,
          resourceName: options.resourceName,
          apiVersion: options.apiVersion,
        }),
      )(model);
    case "bedrock":
      return createAmazonBedrock(defined({ apiKey, baseURL, fetch, region: options.region }))(
        model,
      );
    case "openai-compatible": {
      return createOpenAICompatible({
        name: id,
        baseURL: baseURL ?? "",
        includeUsage: true,
        ...defined({ apiKey, fetch }),
      })(model);
    }
    case "claude-code":
    case "codex":
      // Delegated CLIs never go through the AI SDK (see delegated/).
      throw new Error(`${provider.kind} is a delegated CLI provider, not an SDK model`);
  }
}
