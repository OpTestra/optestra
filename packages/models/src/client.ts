import { randomUUID } from "node:crypto";
import { brand } from "@testament/brand";
import type { Config } from "@testament/config";
import {
  logger as defaultLogger,
  defaultRedactor,
  type Logger,
  processEnvSource,
  type Redactor,
  type SecretSource,
} from "@testament/config/node";
import { revealSecret } from "@testament/config/reveal";
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  NoObjectGeneratedError,
  Output,
  type ModelMessage as SdkMessage,
  type ToolSet,
} from "ai";
import { BudgetMeter } from "./budget.js";
import type { ModelRole } from "./config.js";
import { addUsage, computeCost, priceFor, reportedCost, ZERO_USAGE } from "./cost.js";
import { classifyError, RETRYABLE } from "./errors.js";
import { type PoolEntry, type ResolvedProvider, resolvePools, resolveProviders } from "./keys.js";
import { createLanguageModel } from "./providers.js";
import { type FetchLike, guardedFetch, platformFetch } from "./transport.js";
import type {
  Attempt,
  CompletionFailure,
  CompletionRequest,
  CompletionResult,
  FailureReason,
  ModelCallRecord,
  ModelMessage,
  TokenUsage,
  ToolCall,
} from "./types.js";
import { capUsage, MemoryUsageStore, NEAR_CAP_RATIO, type UsageStore } from "./usage.js";

// The AI SDK prints warnings straight to the console, bypassing redaction. Warnings
// are logged through our redacting logger instead.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

export interface ModelsOptions {
  /** Resolved project config (with the models section). */
  config: Config;
  /** Where provider keys come from. Default: process environment. */
  sources?: readonly SecretSource[];
  /** Selected environment, for `.env.<environment>` key lookup. */
  environment?: string | undefined;
  /** Spend per provider, for usage caps. Default: in memory. */
  usageStore?: UsageStore;
  /** Budgets applied to every call (e.g. the run and suite meters). */
  budgets?: BudgetMeter[];
  /** Receives every call record, success or failure. */
  onCall?: (record: ModelCallRecord) => void;
  logger?: Logger;
  redactor?: Redactor;
  /** Base delay between retries on one entry; doubles each retry. Default 250 ms. */
  backoffMs?: number;
  /** Underlying fetch function; tests pass a fake. Always wrapped by the host guard. */
  fetch?: FetchLike;
  /** Test hook: build the model for an entry instead of using a real provider. */
  languageModel?: (entry: PoolEntry, apiKey: string | undefined) => LanguageModel;
  now?: () => number;
}

export interface Models {
  /** Asks the role's pool for a completion. Never throws on provider trouble. */
  complete<T = never>(role: ModelRole, request: CompletionRequest<T>): Promise<CompletionResult<T>>;
  /** The role's pool as resolved from config and keys. */
  pool(role: ModelRole): PoolEntry[];
  /** Providers disabled for the rest of this run after an auth failure. */
  readonly disabled: ReadonlySet<string>;
}

const MAX_TRIES_PER_ENTRY = 3; // one try + two retries

function toSdkMessages(messages: readonly ModelMessage[]): SdkMessage[] {
  return messages.map((message): SdkMessage => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content.map((part) => ({
          type: "tool-result",
          toolCallId: part.id,
          toolName: part.name,
          output: { type: "json", value: part.output as never },
        })),
      };
    }
    if (typeof message.content === "string")
      return { role: message.role, content: message.content } as SdkMessage;
    if (message.role === "user") {
      return {
        role: "user",
        content: message.content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : { type: "file", mediaType: part.mediaType, data: part.data },
        ),
      };
    }
    return {
      role: "assistant",
      content: message.content.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.input },
      ),
    };
  });
}

function toUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  inputTokenDetails?: { cacheReadTokens: number | undefined; cacheWriteTokens: number | undefined };
}): TokenUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface AttemptResult<T> {
  attempt: Attempt;
  text?: string;
  toolCalls?: ToolCall[];
  object?: T | undefined;
  /** Raw text of an invalid structured reply, for the retry prompt. */
  invalidText?: string;
}

/** Creates the models client for a run. */
export function createModels(options: ModelsOptions): Models {
  const config = options.config;
  const log = options.logger ?? defaultLogger;
  const redactor = options.redactor ?? defaultRedactor;
  const store = options.usageStore ?? new MemoryUsageStore();
  const now = options.now ?? Date.now;
  const backoff = options.backoffMs ?? 250;
  const providers: Map<string, ResolvedProvider> = resolveProviders(
    config,
    options.sources ?? [processEnvSource()],
    options.environment,
  );
  const pools = resolvePools(config, providers);
  const disabled = new Set<string>();
  const warnedPrices = new Set<string>();
  const timeoutDefault = (config.models?.timeoutSeconds ?? 120) * 1000;

  async function attemptOnce<T>(
    entry: PoolEntry,
    tryNumber: number,
    request: CompletionRequest<T>,
    messages: SdkMessage[],
  ): Promise<AttemptResult<T>> {
    const provider = providers.get(entry.provider) as ResolvedProvider;
    let providerCost: number | undefined;
    const fetch = guardedFetch(provider.host ?? "", {
      base: options.fetch ?? platformFetch,
      onJson: (body) => {
        providerCost = reportedCost(body) ?? providerCost;
      },
    });
    // The key is revealed only here, at request time, for this provider's host.
    const apiKey = provider.key ? revealSecret(provider.key) : undefined;
    const model = options.languageModel
      ? options.languageModel(entry, apiKey)
      : createLanguageModel(entry.provider, provider.settings, entry.model, apiKey, fetch);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, request.timeoutMs ?? timeoutDefault);
    const onAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onAbort);
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason));
    });

    const started = now();
    const costOf = (usage: TokenUsage) => {
      if (providerCost !== undefined) return providerCost;
      const cost = computeCost(usage, priceFor(entry.model, config.models?.prices));
      if (cost === null && !warnedPrices.has(entry.model)) {
        warnedPrices.add(entry.model);
        log.warn(`No price known for model ${entry.model}; its cost is recorded as unknown.`, {
          fix: `Add ${entry.model} under models.prices in ${brand.configFileName}.`,
        });
      }
      return cost;
    };
    const base = { provider: entry.provider, model: entry.model, attempt: tryNumber };

    try {
      const tools: ToolSet | undefined = request.tools?.length
        ? Object.fromEntries(
            request.tools.map((tool) => [
              tool.name,
              { description: tool.description, inputSchema: jsonSchema(tool.parameters as never) },
            ]),
          )
        : undefined;
      const system = request.system
        ? request.cache
          ? {
              role: "system" as const,
              content: request.system,
              providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
            }
          : request.system
        : undefined;
      const call = generateText({
        model,
        messages,
        maxRetries: 0,
        temperature: request.temperature ?? 0,
        abortSignal: controller.signal,
        ...(system !== undefined && { system }),
        ...(tools && { tools }),
        ...(request.output && { output: Output.object({ schema: request.output }) }),
        ...(request.maxOutputTokens !== undefined && { maxOutputTokens: request.maxOutputTokens }),
      });
      call.catch(() => {});
      const result = await Promise.race([call, stopped]);
      for (const warning of result.warnings ?? []) log.debug("model warning", { warning });
      const usage = toUsage(result.usage);
      const costUsd = costOf(usage);
      return {
        attempt: { ...base, outcome: "ok", latencyMs: now() - started, usage, costUsd },
        text: result.text,
        toolCalls: result.toolCalls.map((call) => ({
          id: call.toolCallId,
          name: call.toolName,
          input: call.input,
        })),
        object: request.output ? (result.output as T) : undefined,
      };
    } catch (error) {
      const classified = classifyError(error, redactor, {
        timedOut,
        aborted: request.signal?.aborted === true,
      });
      const attempt: Attempt = {
        ...base,
        outcome: classified.outcome,
        latencyMs: now() - started,
        message: classified.message,
        ...(classified.status !== undefined && { status: classified.status }),
      };
      if (NoObjectGeneratedError.isInstance(error) && error.usage) {
        attempt.usage = toUsage(error.usage);
        attempt.costUsd = costOf(attempt.usage);
        return { attempt, ...(error.text !== undefined && { invalidText: error.text }) };
      }
      return { attempt };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  async function nearCap(entry: PoolEntry): Promise<string | undefined> {
    const caps = providers.get(entry.provider)?.settings.caps;
    if (!caps) return undefined;
    const usage = await capUsage(store, entry.provider, caps, now());
    const hit = usage.find((u) => u.ratio >= NEAR_CAP_RATIO);
    return hit
      ? `${entry.provider} has used $${hit.spentUsd.toFixed(2)} of its $${hit.capUsd} ${hit.window} cap`
      : undefined;
  }

  async function complete<T>(
    role: ModelRole,
    request: CompletionRequest<T>,
  ): Promise<CompletionResult<T>> {
    const id = randomUUID();
    const startedAt = now();
    const attempts: Attempt[] = [];
    const meters = [...(options.budgets ?? []), ...(request.budgets ?? [])];

    const record = (outcome: ModelCallRecord["outcome"], answered?: Attempt): ModelCallRecord => {
      const withUsage = attempts.filter((a) => a.usage);
      const unknown = withUsage.some((a) => a.costUsd === null || a.costUsd === undefined);
      const rec: ModelCallRecord = {
        id,
        role,
        startedAt: new Date(startedAt).toISOString(),
        latencyMs: now() - startedAt,
        outcome,
        provider: answered?.provider ?? null,
        model: answered?.model ?? null,
        usage: attempts.reduce((sum, a) => addUsage(sum, a.usage), ZERO_USAGE),
        costUsd: unknown ? null : withUsage.reduce((sum, a) => sum + (a.costUsd ?? 0), 0),
        attempts: [...attempts],
        tags: { ...(request.tags ?? {}) },
      };
      options.onCall?.(rec);
      log.debug(`model call ${role} ${outcome}`, { record: rec });
      return rec;
    };

    const fail = (reason: FailureReason, message: string, fix: string): CompletionFailure => ({
      ok: false,
      reason,
      message: redactor.redact(message),
      fix,
      attempts: [...attempts],
      record: record(reason),
    });

    const budgetStop = () => {
      const meter = meters.find((m) => m.exhausted);
      return meter
        ? fail(
            "budget_exceeded",
            `The ${meter.label} AI budget of $${meter.capUsd} is used up ($${meter.spentUsd.toFixed(4)} spent).`,
            meter.setting
              ? `Raise ${meter.setting} in ${brand.configFileName}, or run again later with a fresh budget.`
              : `Raise the ${meter.label} budget.`,
          )
        : undefined;
    };
    const aborted = () =>
      fail("aborted", "The request was cancelled.", "Nothing to fix; run it again if needed.");

    const early = budgetStop();
    if (early) return early;
    if (request.signal?.aborted) return aborted();

    const pool = pools[role] ?? [];
    for (const entry of pool) {
      const skip = (outcome: Attempt["outcome"], message: string | undefined) =>
        attempts.push({
          provider: entry.provider,
          model: entry.model,
          attempt: 0,
          outcome,
          latencyMs: 0,
          ...(message && { message }),
        });
      if (!entry.usable) {
        skip(entry.keyStatus === "missing" ? "skipped_no_key" : "skipped_unusable", entry.problem);
        continue;
      }
      if (disabled.has(entry.provider)) {
        skip("skipped_disabled", `${entry.provider} was disabled after an authentication failure`);
        continue;
      }
      const capped = await nearCap(entry);
      if (capped) {
        skip("skipped_near_cap", capped);
        continue;
      }

      let messages = toSdkMessages(request.messages);
      let retriedInvalid = false;
      for (let tryNumber = 1; tryNumber <= MAX_TRIES_PER_ENTRY; tryNumber++) {
        const stop = budgetStop();
        if (stop) return stop;
        if (request.signal?.aborted) return aborted();

        const result = await attemptOnce(entry, tryNumber, request, messages);
        const attempt = result.attempt;
        attempts.push(attempt);
        if (attempt.usage) {
          for (const meter of meters) meter.add(attempt.costUsd ?? null);
          if (typeof attempt.costUsd === "number" && attempt.costUsd > 0) {
            await store.record({ provider: entry.provider, usd: attempt.costUsd, at: now() });
          }
        }

        if (attempt.outcome === "ok") {
          const rec = record("ok", attempt);
          return {
            ok: true,
            text: result.text ?? "",
            toolCalls: result.toolCalls ?? [],
            object: result.object,
            usage: rec.usage,
            costUsd: rec.costUsd,
            provider: entry.provider,
            model: entry.model,
            latencyMs: rec.latencyMs,
            attempts: rec.attempts,
            record: rec,
          };
        }
        if (attempt.outcome === "aborted") return aborted();
        if (attempt.outcome === "bad_request") {
          return fail(
            "all_providers_failed",
            `${entry.provider} rejected the request (${attempt.status}): ${attempt.message ?? ""}`,
            "This is a bug in the request, not a provider outage. Report it with the call record.",
          );
        }
        if (attempt.outcome === "auth_failed") {
          disabled.add(entry.provider);
          break;
        }
        if (attempt.outcome === "invalid_output") {
          if (retriedInvalid) break;
          retriedInvalid = true;
          messages = [
            ...messages,
            ...(result.invalidText
              ? [{ role: "assistant" as const, content: result.invalidText }]
              : []),
            {
              role: "user",
              content: `${attempt.message ?? "The reply did not match the schema."} Reply again with only a valid object.`,
            },
          ];
          continue;
        }
        if (!RETRYABLE.has(attempt.outcome) || tryNumber === MAX_TRIES_PER_ENTRY) break;
        await sleep(backoff * 2 ** (tryNumber - 1));
      }
    }

    const tried = attempts.filter((a) => a.attempt > 0);
    const summary = attempts
      .map((a) => `${a.provider}/${a.model}: ${a.outcome}${a.message ? ` (${a.message})` : ""}`)
      .join("; ");
    if (pool.length === 0 || tried.length === 0) {
      return fail(
        "no_provider",
        pool.length === 0
          ? `No models are configured for the ${role} role.`
          : `No model for the ${role} role can be used right now: ${summary}.`,
        pool.length === 0
          ? `Add entries under models.roles.${role} in ${brand.configFileName}.`
          : "Set an API key (for example ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY), or add another provider to the pool.",
      );
    }
    if (tried.every((a) => a.outcome === "auth_failed")) {
      return fail(
        "auth_failed",
        `Every provider for the ${role} role rejected its API key: ${summary}.`,
        "Check the keys (run the models key check) and replace any that are invalid or expired.",
      );
    }
    const lastPerEntry = new Map(tried.map((a) => [`${a.provider}/${a.model}`, a.outcome]));
    if ([...lastPerEntry.values()].every((outcome) => outcome === "invalid_output")) {
      return fail(
        "invalid_output",
        `No model for the ${role} role produced output matching the schema: ${summary}.`,
        "Try a stronger model for this role, or simplify the output schema.",
      );
    }
    return fail(
      "all_providers_failed",
      `Every provider for the ${role} role failed: ${summary}.`,
      "Wait and retry, or add another provider to the pool (models.roles).",
    );
  }

  return {
    complete,
    pool: (role) => pools[role] ?? [],
    disabled,
  };
}

export { BudgetMeter };
