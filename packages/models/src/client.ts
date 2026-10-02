import { randomUUID } from "node:crypto";
import { brand } from "@optestra/brand";
import type { Config } from "@optestra/config";
import {
  logger as defaultLogger,
  defaultRedactor,
  type Logger,
  processEnvSource,
  type Redactor,
  type SecretSource,
} from "@optestra/config/node";
import { revealSecret } from "@optestra/config/reveal";
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  NoObjectGeneratedError,
  Output,
  type ModelMessage as SdkMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { BudgetMeter } from "./budget.js";
import { type ModelCapabilities, probeCapabilities } from "./capabilities.js";
import { isDelegatedKind, type ModelRole } from "./config.js";
import { type ProbeResult, probeBinary, runDelegated } from "./delegated/run.js";
import { addUsage, computeCost, priceAt, reportedCost, ZERO_USAGE } from "./cost.js";
import { classifyError, RETRYABLE } from "./errors.js";
import { type PoolEntry, type ResolvedProvider, resolvePools, resolveProviders } from "./keys.js";
import { aiWaitScope, rateLimitWaitMs, slotsFor, type WaitInfo } from "./limits.js";
import { createLanguageModel, DEFAULT_CONCURRENCY, openRouterRouting } from "./providers.js";
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
  /**
   * Told when a call starts waiting (a rate limit, or no free slot for a few
   * seconds). The waits scope the call runs in (`aiWaitScope`) is told too.
   */
  onWait?: (info: WaitInfo) => void;
  logger?: Logger;
  redactor?: Redactor;
  /** Base delay between retries on one entry; doubles each retry. Default 250 ms. */
  backoffMs?: number;
  /** Underlying fetch function; tests pass a fake. Always wrapped by the host guard. */
  fetch?: FetchLike;
  /** Test hook: how a rate-limit wait sleeps (resolves false when the signal aborted). */
  pause?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  /** Test hook: build the model for an entry instead of using a real provider. */
  languageModel?: (entry: PoolEntry, apiKey: string | undefined) => LanguageModel;
  now?: () => number;
  /** Environment for finding and running subscription CLIs (PATH, HOME…). Default: process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * The Node that runs JS-based subscription CLIs. Default: this process when
   * it is Node, else `node` on PATH, else the app's binary in Node mode (the
   * packaged desktop app, where `process.execPath` is the app).
   */
  node?: string;
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
/** A slot wait shorter than this isn't announced (it is still measured). */
const ANNOUNCE_SLOT_WAIT_MS = 2_000;
/**
 * Output budget floor for models that think before answering: the thinking comes
 * out of the same budget, and the engine's caps (200-500 tokens) are sized for
 * answers alone. Only tokens actually produced are paid for.
 */
const THINKING_OUTPUT_FLOOR = 4_096;
/** Backoff for a 429 without Retry-After: 2 s, doubling, at most a minute. */
const RATE_LIMIT_BACKOFF_MS = 2_000;
const RATE_LIMIT_BACKOFF_CAP_MS = 60_000;

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

/** Sleeps, or stops early when the signal aborts (resolves false then). */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The output schema in words, for models whose provider doesn't enforce it. */
function schemaInstruction(output: z.ZodType): string {
  let schema: unknown;
  try {
    schema = z.toJSONSchema(output);
  } catch {
    return "Reply with only a JSON object, with no other text.";
  }
  return `Reply with only a JSON object that matches this JSON Schema, with no other text, no markdown and no code fence:\n${JSON.stringify(schema)}`;
}

const NO_VISION_NOTE =
  "[A screenshot was taken here, but this model can't read images; use the page snapshot.]";

/** Replaces images with a note, for models that can't read them. */
function withoutImages(messages: SdkMessage[]): SdkMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "file" && part.mediaType.startsWith("image/")
          ? { type: "text" as const, text: NO_VISION_NOTE }
          : part,
      ),
    };
  });
}

const hasImages = (messages: readonly ModelMessage[]) =>
  messages.some(
    (m) =>
      m.role === "user" &&
      typeof m.content !== "string" &&
      m.content.some((p) => p.type === "image"),
  );

interface AttemptResult<T> {
  attempt: Attempt;
  text?: string;
  toolCalls?: ToolCall[];
  object?: T | undefined;
  /** Raw text of an invalid structured reply, for the retry prompt. */
  invalidText?: string;
  /** A rate limit's wait (Retry-After or a reset header), when the provider gave one. */
  retryAfterMs?: number;
}

/** Creates the models client for a run. */
export function createModels(options: ModelsOptions): Models {
  const config = options.config;
  const log = options.logger ?? defaultLogger;
  const redactor = options.redactor ?? defaultRedactor;
  const store = options.usageStore ?? new MemoryUsageStore();
  const now = options.now ?? Date.now;
  const backoff = options.backoffMs ?? 250;
  const parentEnv = options.env ?? process.env;
  const providers: Map<string, ResolvedProvider> = resolveProviders(
    config,
    options.sources ?? [processEnvSource()],
    options.environment,
    parentEnv,
    options.node,
  );
  // Delegated CLIs: probed once per client (version + lock-down flags), and capped per run.
  const probes = new Map<string, Promise<ProbeResult>>();
  const delegatedCalls = new Map<string, number>();
  const callCap = config.models?.delegatedCallsPerRun ?? 60;
  const pools = resolvePools(config, providers);
  const disabled = new Set<string>();
  const warnedPrices = new Set<string>();
  const timeoutDefault = (config.models?.timeoutSeconds ?? 120) * 1000;
  const maxWaitMs = (config.models?.maxWaitMinutes ?? 30) * 60_000;
  const warnedCosts = new Set<string>();
  // Provider metadata is only asked for when requests really go out (not with a test model).
  const probeAllowed = !options.languageModel || options.fetch !== undefined;
  const capabilities = (entry: PoolEntry): Promise<ModelCapabilities> => {
    const provider = providers.get(entry.provider);
    if (!provider?.baseUrl || !provider.host || !probeAllowed) return Promise.resolve({});
    const pinned =
      provider.settings.kind === "openrouter"
        ? openRouterRouting(entry.model, provider.settings.routing, entry.settings?.routing)
            .order?.[0]
        : undefined;
    return probeCapabilities(
      provider.settings.kind,
      provider.baseUrl,
      entry.model,
      guardedFetch(provider.host, { base: options.fetch ?? platformFetch }),
      pinned,
    );
  };

  /** Waits for this provider's (and model's) free slots. Returns the release and the wait. */
  async function takeSlots(
    entry: PoolEntry,
    signal: AbortSignal | undefined,
  ): Promise<{ release: () => void; waitedMs: number } | undefined> {
    const provider = providers.get(entry.provider) as ResolvedProvider;
    const perProvider =
      provider.settings.concurrency ?? DEFAULT_CONCURRENCY[provider.settings.kind];
    const perModel = provider.settings.concurrencyPerModel;
    const account = provider.host ?? entry.provider;
    const pools = [
      ...(perProvider ? [slotsFor(account, perProvider)] : []),
      ...(perModel ? [slotsFor(`${account}|${entry.model}`, perModel)] : []),
    ];
    if (pools.length === 0) return { release: () => {}, waitedMs: 0 };
    const started = now();
    const scope = aiWaitScope.getStore();
    const busy = pools.some((slots) => !slots.free);
    let announced = false;
    const announce = busy
      ? setTimeout(() => {
          announced = true;
          const info: WaitInfo = {
            provider: entry.provider,
            model: entry.model,
            reason: "concurrency",
            resumesAt: null,
            message: `Waiting for a free ${entry.provider} slot (its limit is ${perModel ?? perProvider} at once).`,
          };
          options.onWait?.(info);
          scope?.begin(info);
        }, ANNOUNCE_SLOT_WAIT_MS)
      : undefined;
    // A short slot wait still stops the clock, silently.
    if (busy) scope?.begin();
    const releases: Array<() => void> = [];
    try {
      for (const slots of pools) releases.push(await slots.acquire(signal));
    } catch {
      for (const release of releases) release();
      return undefined;
    } finally {
      clearTimeout(announce);
      if (busy) scope?.end();
      if (announced) scope?.end();
    }
    return {
      release: () => {
        for (const release of releases) release();
      },
      waitedMs: now() - started,
    };
  }

  async function attemptOnce<T>(
    entry: PoolEntry,
    tryNumber: number,
    request: CompletionRequest<T>,
    messages: SdkMessage[],
    schemaHint = false,
  ): Promise<AttemptResult<T>> {
    const provider = providers.get(entry.provider) as ResolvedProvider;
    if (isDelegatedKind(provider.settings.kind))
      return delegatedAttempt(entry, provider, tryNumber, request, messages);
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
      : createLanguageModel(
          entry.provider,
          provider.settings,
          entry.model,
          apiKey,
          fetch,
          entry.settings?.routing,
        );

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
    const costOf = (
      usage: TokenUsage,
    ): Pick<Attempt, "costUsd" | "listCostUsd" | "reportedCostUsd"> => {
      const list = computeCost(
        usage,
        priceAt(provider.settings.kind, entry.model, config.models?.prices),
      );
      if (list === null && providerCost === undefined && !warnedPrices.has(entry.model)) {
        warnedPrices.add(entry.model);
        log.warn(`No price known for model ${entry.model}; its cost is recorded as unknown.`, {
          fix: `Add ${entry.model} under models.prices in ${brand.configFileName}.`,
        });
      }
      // The provider's charge vs our list price: a gap means prices.yaml is stale.
      if (
        list !== null &&
        providerCost !== undefined &&
        providerCost > 0.0001 &&
        Math.abs(providerCost - list) / providerCost > 0.05 &&
        !warnedCosts.has(entry.model)
      ) {
        warnedCosts.add(entry.model);
        log.warn(
          `${entry.provider} charged $${providerCost.toFixed(6)} for a ${entry.model} call; the list price says $${list.toFixed(6)}.`,
          { fix: `Check the price of ${entry.model} in prices.yaml (or models.prices).` },
        );
      }
      return {
        costUsd: providerCost ?? list,
        listCostUsd: list,
        ...(providerCost !== undefined ? { reportedCostUsd: providerCost } : {}),
      };
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
      // Providers that don't enforce a JSON schema get it spelled out in the prompt too.
      const systemText =
        schemaHint && request.output
          ? [request.system, schemaInstruction(request.output)].filter(Boolean).join("\n\n")
          : request.system;
      const system = systemText
        ? request.cache
          ? {
              role: "system" as const,
              content: systemText,
              providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
            }
          : systemText
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
      return {
        attempt: { ...base, outcome: "ok", latencyMs: now() - started, usage, ...costOf(usage) },
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
        Object.assign(attempt, costOf(attempt.usage));
        return { attempt, ...(error.text !== undefined && { invalidText: error.text }) };
      }
      const wait =
        classified.outcome === "rate_limited"
          ? rateLimitWaitMs(classified.headers, now())
          : undefined;
      return { attempt, ...(wait !== undefined ? { retryAfterMs: wait } : {}) };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** One call through the user's own subscription CLI (MOD-6). Cost 0 to budgets. */
  async function delegatedAttempt<T>(
    entry: PoolEntry,
    provider: ResolvedProvider,
    tryNumber: number,
    request: CompletionRequest<T>,
    messages: SdkMessage[],
  ): Promise<AttemptResult<T>> {
    const kind = provider.settings.kind as "claude-code" | "codex";
    const base = {
      provider: entry.provider,
      model: entry.model,
      attempt: tryNumber,
      billing: "subscription" as const,
    };
    const started = now();
    const binary = provider.binary;
    if (!binary) {
      return {
        attempt: {
          ...base,
          outcome: "cli_unavailable",
          latencyMs: 0,
          message: provider.problem ?? "not installed",
        },
      };
    }
    let probe = probes.get(entry.provider);
    if (!probe) {
      probe = probeBinary(kind, binary, parentEnv);
      probes.set(entry.provider, probe);
    }
    const probed = await probe;
    if (!probed.installed || !probed.meetsMinimum) {
      return {
        attempt: {
          ...base,
          outcome: "cli_unavailable",
          latencyMs: now() - started,
          message: redactor.redact(probed.problem ?? "unavailable"),
        },
      };
    }
    delegatedCalls.set(entry.provider, (delegatedCalls.get(entry.provider) ?? 0) + 1);
    const result = await runDelegated(
      kind,
      binary,
      {
        system: request.system,
        messages,
        tools: request.tools,
        output: request.output as never,
        model: entry.model,
        timeoutMs: request.timeoutMs ?? timeoutDefault,
        signal: request.signal,
      },
      parentEnv,
    );
    const attempt: Attempt = {
      ...base,
      outcome: result.outcome,
      latencyMs: now() - started,
      ...(result.message !== undefined ? { message: redactor.redact(result.message) } : {}),
      ...(result.usage ? { usage: result.usage, costUsd: 0 } : {}),
      ...(result.reportedCostUsd !== undefined ? { reportedCostUsd: result.reportedCostUsd } : {}),
    };
    if (result.outcome !== "ok") {
      return {
        attempt,
        ...(result.invalidText !== undefined ? { invalidText: result.invalidText } : {}),
      };
    }
    return {
      attempt: { ...attempt, usage: result.usage ?? ZERO_USAGE, costUsd: 0 },
      text: result.text ?? "",
      toolCalls: result.toolCalls ?? [],
      object: result.object as T | undefined,
    };
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
      const listUnknown = withUsage.some(
        (a) =>
          a.listCostUsd === null || (a.listCostUsd === undefined && a.billing !== "subscription"),
      );
      const reported = withUsage.filter((a) => a.reportedCostUsd !== undefined);
      const waitMs = attempts.reduce((sum, a) => sum + (a.waitMs ?? 0), 0);
      const rec: ModelCallRecord = {
        id,
        role,
        startedAt: new Date(startedAt).toISOString(),
        latencyMs: Math.max(0, now() - startedAt - waitMs),
        waitMs,
        outcome,
        provider: answered?.provider ?? null,
        model: answered?.model ?? null,
        usage: attempts.reduce((sum, a) => addUsage(sum, a.usage), ZERO_USAGE),
        costUsd: unknown ? null : withUsage.reduce((sum, a) => sum + (a.costUsd ?? 0), 0),
        listCostUsd: listUnknown
          ? null
          : withUsage.reduce((sum, a) => sum + (a.listCostUsd ?? a.costUsd ?? 0), 0),
        ...(reported.length > 0 &&
        reported.length === withUsage.length &&
        answered?.billing !== "subscription"
          ? { reportedCostUsd: reported.reduce((sum, a) => sum + (a.reportedCostUsd ?? 0), 0) }
          : {}),
        attempts: [...attempts],
        tags: { ...(request.tags ?? {}) },
        billing: (answered ?? attempts.filter((a) => a.attempt > 0).at(-1))?.billing ?? "api",
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
        skip(
          "skipped_disabled",
          `${entry.provider} was disabled earlier in this run (not signed in, rejected key, or unavailable)`,
        );
        continue;
      }
      if (
        isDelegatedKind(providers.get(entry.provider)?.settings.kind ?? "") &&
        (delegatedCalls.get(entry.provider) ?? 0) >= callCap
      ) {
        skip(
          "skipped_call_cap",
          `${entry.provider} reached this run's ${callCap} calls (models.delegatedCallsPerRun)`,
        );
        continue;
      }
      const capped = await nearCap(entry);
      if (capped) {
        skip("skipped_near_cap", capped);
        continue;
      }
      // What the provider says the model can do: no tools means it can't do this work.
      const caps = await capabilities(entry);
      if (request.tools?.length && caps.tools === false) {
        skip("skipped_unusable", `${entry.model} can't call tools (says ${entry.provider})`);
        continue;
      }
      if (caps.pinServed === false) {
        const pin = openRouterRouting(
          entry.model,
          providers.get(entry.provider)?.settings.routing,
          entry.settings?.routing,
        ).order?.[0];
        skip(
          "skipped_unusable",
          `${entry.provider} has no ${pin} endpoint for ${entry.model} (set routing.order for this model)`,
        );
        continue;
      }
      const vision = entry.settings?.vision ?? caps.vision;
      const kind = providers.get(entry.provider)?.settings.kind;
      const schemaHint =
        kind === "ollama-cloud" ||
        kind === "openai-compatible" ||
        (kind === "openrouter" && caps.structuredOutput === false);

      const asked =
        caps.thinking && request.maxOutputTokens !== undefined
          ? {
              ...request,
              maxOutputTokens: Math.max(request.maxOutputTokens, THINKING_OUTPUT_FLOOR),
            }
          : request;
      let messages = toSdkMessages(request.messages);
      if (vision === false && hasImages(request.messages)) messages = withoutImages(messages);
      let retriedInvalid = false;
      let rateLimited = 0;
      let waitedForLimits = 0;
      for (let tryNumber = 1; tryNumber <= MAX_TRIES_PER_ENTRY; tryNumber++) {
        const stop = budgetStop();
        if (stop) return stop;
        if (request.signal?.aborted) return aborted();

        const slots = await takeSlots(entry, request.signal);
        if (!slots) return aborted();
        let result: AttemptResult<T>;
        try {
          result = await attemptOnce(entry, tryNumber, asked, messages, schemaHint);
        } finally {
          slots.release();
        }
        const attempt = result.attempt;
        if (slots.waitedMs > 0) attempt.waitMs = slots.waitedMs;
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
        if (
          attempt.outcome === "auth_failed" ||
          attempt.outcome === "cli_unavailable" ||
          attempt.outcome === "out_of_credit"
        ) {
          disabled.add(entry.provider);
          break;
        }
        // A rate limit is waited out (Retry-After, else a growing backoff), up to
        // models.maxWaitMinutes for this call; waiting doesn't use up a try.
        if (attempt.outcome === "rate_limited") {
          // At least a second, so a "Retry-After: 0" can't turn into a busy loop.
          const wait = Math.max(
            1_000,
            result.retryAfterMs ??
              Math.min(RATE_LIMIT_BACKOFF_MS * 2 ** rateLimited, RATE_LIMIT_BACKOFF_CAP_MS),
          );
          rateLimited++;
          if (waitedForLimits + wait > maxWaitMs) {
            attempt.message = `${attempt.message ?? "rate limited"} (the next wait, ${Math.ceil(wait / 1000)} s, would pass models.maxWaitMinutes)`;
            break;
          }
          const resumesAt = new Date(now() + wait).toISOString();
          const info: WaitInfo = {
            provider: entry.provider,
            model: entry.model,
            reason: "rate_limited",
            resumesAt,
            message: `${entry.provider} is rate-limiting ${entry.model}: waiting ${Math.ceil(wait / 1000)} s, resumes at ${resumesAt}.`,
          };
          const scope = aiWaitScope.getStore();
          options.onWait?.(info);
          scope?.begin(info);
          const started = now();
          const finished = await (options.pause ?? pause)(wait, request.signal);
          scope?.end();
          const waited = now() - started;
          waitedForLimits += waited;
          attempt.waitMs = (attempt.waitMs ?? 0) + waited;
          if (!finished) return aborted();
          tryNumber--;
          continue;
        }
        // The subscription's usage limit: no point retrying this entry; move on.
        if (attempt.outcome === "plan_limit") break;
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
    const capped = attempts.filter((a) => a.outcome === "skipped_call_cap");
    if (pool.length > 0 && tried.length === 0 && capped.length > 0) {
      const names = [...new Set(capped.map((a) => a.provider))].join(", ");
      return fail(
        "no_provider",
        `This run has made its ${callCap} calls through your AI subscription (${names}), the most one run may make (models.delegatedCallsPerRun). The limit protects your plan's usage; the rest of this run's AI steps are blocked.`,
        `Run again to continue, or raise models.delegatedCallsPerRun in ${brand.configFileName} (default 60), or add an API key as another provider (models.roles.${role}).`,
      );
    }
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
        `Every provider for the ${role} role rejected its credentials (API key, or not signed in to the subscription CLI): ${summary}.`,
        "Check the keys (run the models key check) and replace any that are invalid or expired. For a subscription CLI, sign in with its own command (claude auth login, codex login).",
      );
    }
    if (tried.some((a) => a.outcome === "plan_limit") && tried.every((a) => a.outcome !== "ok")) {
      return fail(
        "all_providers_failed",
        `Plan limit reached: your AI subscription's usage limit was hit, and no other provider answered: ${summary}.`,
        "Wait for the plan's limit to reset, or add an API key as another provider in the pool (models.roles).",
      );
    }
    if (
      tried.some((a) => a.outcome === "out_of_credit") &&
      tried.every((a) => a.outcome !== "ok")
    ) {
      const names = [
        ...new Set(tried.filter((a) => a.outcome === "out_of_credit").map((a) => a.provider)),
      ];
      return fail(
        "all_providers_failed",
        `Out of AI credit: ${names.join(", ")} said the account's credit or the key's spend limit is used up, and no other provider answered: ${summary}.`,
        "Add credit (or raise the key's limit) at the provider, or add another provider to the pool (models.roles).",
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
