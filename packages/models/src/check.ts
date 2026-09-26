import { brand } from "@testament/brand";
import type { Config } from "@testament/config";
import { defaultRedactor, processEnvSource, type SecretSource } from "@testament/config/node";
import { revealSecret } from "@testament/config/reveal";
import { generateText, type LanguageModel } from "ai";
import { isDelegatedKind, type ProviderKind } from "./config.js";
import { INSTALL_HINT, SIGN_IN_COMMAND, VENDOR_LABEL } from "./delegated/lockdown.js";
import { probeBinary, signInStatus } from "./delegated/run.js";
import { type ResolvedProvider, resolveProviders } from "./keys.js";
import { createLanguageModel } from "./providers.js";
import { type FetchLike, guardedFetch, platformFetch } from "./transport.js";

export type ProviderCheckStatus =
  | "valid"
  | "invalid_key"
  | "unreachable"
  | "no_key"
  | "misconfigured"
  | "error"
  /** Delegated CLIs (MOD-6). */
  | "not_installed"
  | "outdated"
  | "not_signed_in"
  | "disabled";

export interface ProviderCheck {
  provider: string;
  kind: ProviderKind;
  status: ProviderCheckStatus;
  message: string;
  fix: string;
  /** Delegated CLIs: the installed version, when known. */
  version?: string;
}

export interface CheckOptions {
  sources?: readonly SecretSource[];
  environment?: string | undefined;
  fetch?: FetchLike;
  /** Per provider. Default 10 s. */
  timeoutMs?: number;
  /** Environment for finding and running subscription CLIs. Default: process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Test hook for providers checked with a 1-token completion (azure, bedrock). */
  languageModel?: (provider: string, model: string, apiKey: string | undefined) => LanguageModel;
}

function listRequest(
  provider: ResolvedProvider,
  apiKey: string | undefined,
): { url: string; headers: Record<string, string> } {
  const base = (provider.baseUrl ?? "").replace(/\/+$/, "");
  switch (provider.settings.kind) {
    case "anthropic":
      return {
        url: `${base}/models?limit=1`,
        headers: { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" },
      };
    case "google":
      return { url: `${base}/models?pageSize=1`, headers: { "x-goog-api-key": apiKey ?? "" } };
    default: {
      // OpenRouter's model list is public, so its key endpoint is the real check.
      const path = provider.host === "openrouter.ai" ? "/key" : "/models";
      return {
        url: `${base}${path}`,
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      };
    }
  }
}

/**
 * The cheapest possible call per configured provider (a model list, or a
 * 1-token completion for azure and bedrock), for `doctor` and the Setup check.
 * Only makes network calls when invoked. Never throws.
 */
export async function checkProviders(
  config: Config,
  options: CheckOptions = {},
): Promise<ProviderCheck[]> {
  const env = options.env ?? process.env;
  const providers = resolveProviders(
    config,
    options.sources ?? [processEnvSource()],
    options.environment,
    env,
  );
  const timeoutMs = options.timeoutMs ?? 10_000;
  const redact = (text: string) => defaultRedactor.redact(text).slice(0, 300);
  const checks = [...providers.values()].map(async (provider): Promise<ProviderCheck> => {
    const base = { provider: provider.id, kind: provider.settings.kind };
    const keyName = provider.settings.keySecret;
    if (isDelegatedKind(provider.settings.kind)) {
      const kind = provider.settings.kind;
      if (config.models?.allowDelegated === false) {
        return {
          ...base,
          status: "disabled",
          message: "Subscription CLIs are turned off here (models.allowDelegated: false).",
          fix: "Nothing to do in the cloud; locally, set models.allowDelegated: true.",
        };
      }
      if (!provider.binary) {
        return {
          ...base,
          status: "not_installed",
          message: provider.problem ?? "Not installed.",
          fix: INSTALL_HINT[kind],
        };
      }
      const probe = await probeBinary(kind, provider.binary, env);
      const version = probe.version ? { version: probe.version } : {};
      if (!probe.installed)
        return {
          ...base,
          ...version,
          status: "not_installed",
          message: probe.problem ?? "Could not run it.",
          fix: INSTALL_HINT[kind],
        };
      if (!probe.meetsMinimum)
        return {
          ...base,
          ...version,
          status: "outdated",
          message: probe.problem ?? "Too old.",
          fix:
            kind === "claude-code"
              ? "Run `claude update`."
              : "Update Codex (npm install -g @openai/codex@latest).",
        };
      const status = await signInStatus(kind, provider.binary, env);
      if (!status.signedIn) {
        return {
          ...base,
          ...version,
          status: "not_signed_in",
          message: `Installed${probe.version ? ` (${probe.version})` : ""}, not signed in.`,
          fix: status.fix ?? `Run \`${SIGN_IN_COMMAND[kind]}\`.`,
        };
      }
      return {
        ...base,
        ...version,
        status: "valid",
        message: `Ready: uses your ${VENDOR_LABEL[kind]}${probe.version ? ` ${probe.version}` : ""}.`,
        fix: "Nothing to do.",
      };
    }
    if (provider.problem || !provider.host) {
      return {
        ...base,
        status: "misconfigured",
        message: provider.problem ?? "No API host.",
        fix: `Fix models.providers.${provider.id} in ${brand.configFileName}.`,
      };
    }
    if (provider.keyStatus === "missing" && keyName) {
      return {
        ...base,
        status: "no_key",
        message: `No value for ${keyName}.`,
        fix: `Set the ${keyName} environment variable or add ${keyName}=<key> to .env.`,
      };
    }
    const apiKey = provider.key ? revealSecret(provider.key) : undefined;
    const signal = AbortSignal.timeout(timeoutMs);
    const request = guardedFetch(provider.host, { base: options.fetch ?? platformFetch });
    try {
      let status: number;
      let body = "";
      if (provider.settings.kind === "azure" || provider.settings.kind === "bedrock") {
        const model = Object.values(config.models?.roles ?? {})
          .flat()
          .find((entry) => entry.provider === provider.id)?.model;
        if (!model) {
          return {
            ...base,
            status: "misconfigured",
            message: "No role uses this provider, so there is no model to test the key with.",
            fix: `Add a models.roles entry for ${provider.id}, or remove the provider.`,
          };
        }
        const languageModel =
          options.languageModel?.(provider.id, model, apiKey) ??
          createLanguageModel(provider.id, provider.settings, model, apiKey, request);
        await generateText({
          model: languageModel,
          prompt: "ok",
          maxOutputTokens: 1,
          maxRetries: 0,
          abortSignal: signal,
        });
        status = 200;
      } else {
        const { url, headers } = listRequest(provider, apiKey);
        const response = await request(url, { headers, signal });
        status = response.status;
        if (!response.ok) body = await response.text();
      }
      if (status >= 200 && status < 300) {
        return {
          ...base,
          status: "valid",
          message: `Key accepted by ${provider.host}.`,
          fix: "Nothing to do.",
        };
      }
      return classifyStatus(base, status, redact(body), provider, keyName);
    } catch (error) {
      const status = (error as { statusCode?: unknown }).statusCode;
      if (typeof status === "number")
        return classifyStatus(
          base,
          status,
          redact(String((error as Error).message)),
          provider,
          keyName,
        );
      return {
        ...base,
        status: "unreachable",
        message: redact(
          `Could not reach ${provider.host}: ${error instanceof Error ? error.message : String(error)}`,
        ),
        fix: `Check the network connection and models.providers.${provider.id}.baseUrl.`,
      };
    }
  });
  return Promise.all(checks);
}

function classifyStatus(
  base: { provider: string; kind: ProviderKind },
  status: number,
  body: string,
  provider: ResolvedProvider,
  keyName: string | undefined,
): ProviderCheck {
  if (status === 401 || status === 403) {
    return {
      ...base,
      status: "invalid_key",
      message: `${provider.host} rejected the key (${status}).`,
      fix: keyName
        ? `Replace ${keyName} with a valid key.`
        : "This provider needs a key: set models.providers.<id>.keySecret.",
    };
  }
  if (status >= 500) {
    return {
      ...base,
      status: "unreachable",
      message: `${provider.host} answered ${status}.`,
      fix: "Try again later.",
    };
  }
  return {
    ...base,
    status: "error",
    message: `${provider.host} answered ${status}${body ? `: ${body}` : ""}.`,
    fix: `Check models.providers.${provider.id} in ${brand.configFileName}.`,
  };
}
