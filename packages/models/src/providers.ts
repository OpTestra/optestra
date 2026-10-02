import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { ProviderSettings, RoutingSettings } from "./config.js";
import type { FetchLike } from "./transport.js";

const DEFAULT_BASE_URLS: Partial<Record<ProviderSettings["kind"], string>> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  openrouter: "https://openrouter.ai/api/v1",
  // Ollama's cloud speaks the OpenAI chat API, tools included
  // (docs.ollama.com/api/openai-compatibility); its native /api/chat isn't needed.
  "ollama-cloud": "https://ollama.com/v1",
};

/** The key secret a named provider uses when its config gives none. */
export const DEFAULT_KEY_SECRETS: Partial<Record<ProviderSettings["kind"], string>> = {
  openrouter: "OPENROUTER_API_KEY",
  "ollama-cloud": "OLLAMA_API_KEY",
};

/** Requests in flight per provider when its config says nothing (the plan's own limits). */
export const DEFAULT_CONCURRENCY: Partial<Record<ProviderSettings["kind"], number>> = {
  openrouter: 8,
  // Ollama Pro: 3 concurrent requests (ollama.com/pricing); more are queued by Ollama.
  "ollama-cloud": 3,
};

/**
 * OpenRouter upstream provider for a model author, so a call goes to the model's
 * own maker at its list price and full precision, never to a cheaper quantized
 * host. Authors not listed get no pin (the doctor says so).
 */
export const AUTHOR_ENDPOINTS: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google-ai-studio",
  moonshotai: "moonshotai",
  "z-ai": "z-ai",
  deepseek: "deepseek",
  minimax: "minimax",
  qwen: "alibaba",
  mistralai: "mistral",
  "x-ai": "xai",
};

export interface ResolvedRouting {
  order?: string[];
  allowFallbacks: boolean;
  dataCollection: "allow" | "deny";
  zdr?: boolean;
}

/**
 * The routing an OpenRouter call uses: the entry's, else the provider's, else
 * the default (pinned to the model author, no fallbacks, no data collection).
 */
export function openRouterRouting(
  model: string,
  provider?: RoutingSettings,
  entry?: RoutingSettings,
): ResolvedRouting {
  const author = model.split("/")[0] ?? "";
  const pin = AUTHOR_ENDPOINTS[author];
  const merged = { ...provider, ...entry };
  return {
    ...(merged.order ? { order: merged.order } : pin ? { order: [pin] } : {}),
    allowFallbacks: merged.allowFallbacks ?? false,
    dataCollection: merged.dataCollection ?? "deny",
    ...(merged.zdr !== undefined ? { zdr: merged.zdr } : {}),
  };
}

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
  entryRouting?: RoutingSettings,
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
    case "openrouter": {
      const routing = openRouterRouting(model, provider.routing, entryRouting);
      return createOpenRouter(
        defined({
          apiKey,
          baseURL: baseURL ?? DEFAULT_BASE_URLS.openrouter,
          fetch,
          compatibility: "strict" as const,
        }),
      ).chat(model, {
        provider: {
          ...(routing.order ? { order: routing.order } : {}),
          allow_fallbacks: routing.allowFallbacks,
          data_collection: routing.dataCollection,
          ...(routing.zdr !== undefined ? { zdr: routing.zdr } : {}),
        },
        // Cost and cache tokens in every response (now always on; harmless to ask).
        usage: { include: true },
      });
    }
    case "ollama-cloud":
      return createOpenAICompatible({
        name: id,
        baseURL: baseURL ?? DEFAULT_BASE_URLS["ollama-cloud"] ?? "",
        includeUsage: true,
        // Ollama honours a JSON schema (response_format json_schema); without this
        // the SDK sends only json_object and the model never sees the schema.
        supportsStructuredOutputs: true,
        ...defined({ apiKey, fetch }),
      })(model);
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
