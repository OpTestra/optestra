import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MODEL_SUPPORT, resetCapabilityProbes } from "./capabilities.js";
import { createModels } from "./client.js";
import { AiWaits, resetLimiters, withAiWaits, type WaitInfo } from "./limits.js";
import { openRouterRouting } from "./providers.js";
import { captureLogs, keySources, testConfig } from "./test-kit.test-support.js";
import type { CompletionRequest, ModelCallRecord } from "./types.js";

// The named providers (PROV-0) through their real SDK transports, against
// recorded responses served by a fake fetch: no network. Response bodies follow
// the providers' documented shapes (openrouter.ai/docs/api-reference/overview,
// docs.ollama.com/api/openai-compatibility).

const KEYS = { OPENROUTER_API_KEY: "sk-or-v1-test-1f2e3d", OLLAMA_API_KEY: "ollama-test-9a8b7c" };

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

/** A fetch that records each request and answers from `route`. */
function fakeFetch(route: (seen: Seen, index: number) => Reply | Promise<Reply>) {
  const seen: Seen[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const request: Seen = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
    };
    seen.push(request);
    const reply = await route(request, seen.length - 1);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { fetch, seen };
}

const TOOL = {
  name: "click",
  description: "Click an element.",
  parameters: {
    type: "object",
    properties: { ref: { type: "string" } },
    required: ["ref"],
    additionalProperties: false,
  },
};

const plannerAsk: CompletionRequest = {
  system: "You are the planner. Call exactly the tools you need.",
  messages: [{ role: "user", content: "Step 1: Click 'Sign in'. Page: [e1] button 'Sign in'" }],
  tools: [TOOL],
  cache: true,
};

/** OpenRouter: a tool call from claude-sonnet-5.5 served by Anthropic, cache read + reported cost. */
const openRouterToolCall = (cost = 0.0025072) => ({
  id: "gen-1759400000-AbCdEf",
  provider: "Anthropic",
  model: "anthropic/claude-sonnet-5.5",
  object: "chat.completion",
  created: 1759400000,
  choices: [
    {
      index: 0,
      logprobs: null,
      finish_reason: "tool_calls",
      native_finish_reason: "tool_use",
      message: {
        role: "assistant",
        content: "",
        refusal: null,
        reasoning: null,
        tool_calls: [
          {
            id: "toolu_01AbCd",
            index: 0,
            type: "function",
            function: { name: "click", arguments: '{"ref":"e1"}' },
          },
        ],
      },
    },
  ],
  usage: {
    prompt_tokens: 5_420,
    completion_tokens: 48,
    total_tokens: 5_468,
    cost,
    is_byok: false,
    prompt_tokens_details: { cached_tokens: 4_896, cache_write_tokens: 0, audio_tokens: 0 },
    cost_details: { upstream_inference_cost: null },
    completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0 },
  },
});

/** OpenRouter's model endpoints listing (public), trimmed to what the probe reads. */
const endpoints = (model: string, input: string[], list: Array<[string, string[]]>) => ({
  data: {
    id: model,
    architecture: { input_modalities: input, output_modalities: ["text"] },
    endpoints: list.map(([tag, supported_parameters]) => ({ tag, supported_parameters })),
  },
});

/** Ollama Cloud (OpenAI-compatible /v1): a tool call from deepseek-v4.1-flash. */
const ollamaToolCall = () => ({
  id: "chatcmpl-412",
  object: "chat.completion",
  created: 1759400000,
  model: "deepseek-v4.1-flash",
  system_fingerprint: "fp_ollama",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_x7k2",
            index: 0,
            type: "function",
            function: { name: "click", arguments: '{"ref":"e1"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 5_380, completion_tokens: 31, total_tokens: 5_411 },
});

const ollamaShow = (capabilities: string[]) => ({
  capabilities,
  details: { family: "kimi" },
  model_info: {},
});

function openRouterConfig(
  model = "anthropic/claude-sonnet-5.5",
  extra: Record<string, unknown> = {},
) {
  return testConfig({
    providers: { openrouter: { kind: "openrouter" } },
    roles: {
      planner: [{ provider: "openrouter", model, ...extra }],
      fixer: [{ provider: "openrouter", model, ...extra }],
    },
  });
}

function ollamaConfig(model = "deepseek-v4.1-flash", provider: Record<string, unknown> = {}) {
  return testConfig({
    providers: { ollama: { kind: "ollama-cloud", ...provider } },
    roles: {
      planner: [{ provider: "ollama", model }],
      fixer: [{ provider: "ollama", model }],
    },
  });
}

afterEach(() => {
  resetCapabilityProbes();
  resetLimiters();
});

describe("openrouter", () => {
  it("defaults: pinned to the model author, no fallbacks, no data collection", () => {
    expect(openRouterRouting("anthropic/claude-sonnet-5.5")).toEqual({
      order: ["anthropic"],
      allowFallbacks: false,
      dataCollection: "deny",
    });
    expect(openRouterRouting("moonshotai/deepseek-v4.1-flash").order).toEqual(["moonshotai"]);
    expect(openRouterRouting("qwen/qwen3.8-max-0902").order).toEqual(["alibaba"]);
    expect(openRouterRouting("someone/unknown-model").order).toBeUndefined();
    // The entry beats the provider, which beats the default.
    expect(
      openRouterRouting(
        "anthropic/claude-sonnet-5.5",
        { order: ["amazon-bedrock"], zdr: true },
        { allowFallbacks: true },
      ),
    ).toEqual({
      order: ["amazon-bedrock"],
      allowFallbacks: true,
      dataCollection: "deny",
      zdr: true,
    });
  });

  it("planner tool path: pin, cache breakpoint, tool call, cached tokens, reported and list cost", async () => {
    const { fetch, seen } = fakeFetch((req) =>
      req.url.endsWith("/endpoints")
        ? {
            body: endpoints(
              "anthropic/claude-sonnet-5.5",
              ["text", "image"],
              [
                ["anthropic", ["tools", "structured_outputs"]],
                ["google-vertex/global", ["tools"]],
              ],
            ),
          }
        : { body: openRouterToolCall() },
    );
    const records: ModelCallRecord[] = [];
    const models = createModels({
      config: openRouterConfig(),
      sources: keySources(KEYS),
      fetch,
      onCall: (r) => records.push(r),
    });
    const result = await models.complete("planner", plannerAsk);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolCalls).toEqual([{ id: "toolu_01AbCd", name: "click", input: { ref: "e1" } }]);
    expect(result.usage).toEqual({
      inputTokens: 5_420,
      outputTokens: 48,
      cachedInputTokens: 4_896,
      cacheWriteTokens: 0,
    });
    // costUsd is what OpenRouter charged; the list price sits beside it.
    expect(result.record.costUsd).toBe(0.0025072);
    expect(result.record.reportedCostUsd).toBe(0.0025072);
    const list = ((5_420 - 4_896) * 2 + 4_896 * 0.2 + 48 * 10) / 1e6;
    expect(result.record.listCostUsd).toBeCloseTo(list, 10);
    expect(Math.abs(list - 0.0025072) / 0.0025072).toBeLessThan(0.01);

    const chat = seen.find((s) => s.url === "https://openrouter.ai/api/v1/chat/completions");
    expect(chat?.headers.authorization).toBe(`Bearer ${KEYS.OPENROUTER_API_KEY}`);
    expect(chat?.body).toMatchObject({
      model: "anthropic/claude-sonnet-5.5",
      provider: { order: ["anthropic"], allow_fallbacks: false, data_collection: "deny" },
      usage: { include: true },
      tools: [{ type: "function", function: { name: "click" } }],
    });
    // The stable system prompt carries the Anthropic cache breakpoint.
    const messages = chat?.body?.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toMatchObject({
      role: "system",
      content: [{ type: "text", cache_control: { type: "ephemeral" } }],
    });
    // The metadata probe is public: no key goes with it.
    const probe = seen.find((s) => s.url.endsWith("/endpoints"));
    expect(probe?.url).toBe(
      "https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5.5/endpoints",
    );
    expect(probe?.headers.authorization).toBeUndefined();
  });

  it("structured output (a decision's JSON) parses through OpenRouter", async () => {
    const { fetch, seen } = fakeFetch((req) =>
      req.url.endsWith("/endpoints")
        ? {
            body: endpoints(
              "anthropic/claude-sonnet-5.5",
              ["text"],
              [["anthropic", ["tools", "structured_outputs"]]],
            ),
          }
        : {
            body: {
              ...openRouterToolCall(),
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant", content: '{"same":true,"confidence":0.92}' },
                },
              ],
            },
          },
    );
    const models = createModels({ config: openRouterConfig(), sources: keySources(KEYS), fetch });
    const result = await models.complete("fixer", {
      messages: [{ role: "user", content: "Same element?" }],
      output: z.object({ same: z.boolean(), confidence: z.number() }),
    });
    expect(result.ok && result.object).toEqual({ same: true, confidence: 0.92 });
    const chat = seen.find((s) => s.url.endsWith("/chat/completions"));
    expect(chat?.body?.response_format).toMatchObject({ type: "json_schema" });
  });

  it("a 402 (credit used up) disables the provider and moves on, with a plain message", async () => {
    const { fetch } = fakeFetch((req) =>
      req.url.endsWith("/endpoints")
        ? { status: 404, body: {} }
        : {
            status: 402,
            body: {
              error: {
                code: 402,
                message: "This request requires more credits.",
                metadata: { limit_source: "openrouter_key_limit" },
              },
            },
          },
    );
    const models = createModels({ config: openRouterConfig(), sources: keySources(KEYS), fetch });
    const first = await models.complete("planner", plannerAsk);
    expect(first).toMatchObject({ ok: false, reason: "all_providers_failed" });
    expect(!first.ok && first.message).toContain("Out of AI credit");
    expect(first.attempts[0]).toMatchObject({ outcome: "out_of_credit", status: 402 });
    const second = await models.complete("planner", plannerAsk);
    expect(second.attempts[0]?.outcome).toBe("skipped_disabled");
  });

  it("a model whose pinned upstream doesn't serve it is skipped, saying how to fix it", async () => {
    const { fetch, seen } = fakeFetch(() => ({
      body: endpoints("deepseek/deepseek-v4-pro", ["text"], [["alibaba/fp8", ["tools"]]]),
    }));
    const models = createModels({
      config: openRouterConfig("deepseek/deepseek-v4-pro"),
      sources: keySources(KEYS),
      fetch,
    });
    const result = await models.complete("planner", plannerAsk);
    expect(result.ok).toBe(false);
    expect(result.attempts[0]).toMatchObject({ outcome: "skipped_unusable" });
    expect(result.attempts[0]?.message).toContain("no deepseek endpoint");
    expect(seen.some((s) => s.url.endsWith("/chat/completions"))).toBe(false);
  });
});

describe("ollama-cloud", () => {
  it("planner tool path over the OpenAI-compatible API, priced from its credit rates", async () => {
    const { fetch, seen } = fakeFetch((req) =>
      req.url.endsWith("/api/show")
        ? { body: ollamaShow(["completion", "tools", "vision", "thinking"]) }
        : { body: ollamaToolCall() },
    );
    const models = createModels({ config: ollamaConfig(), sources: keySources(KEYS), fetch });
    const result = await models.complete("planner", plannerAsk);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolCalls).toEqual([{ id: "call_x7k2", name: "click", input: { ref: "e1" } }]);
    // deepseek-v4.1-flash on Ollama credits: $0.30 in / $1.20 out per million (ollama.com/pricing).
    expect(result.costUsd).toBeCloseTo((5_380 * 0.3 + 31 * 1.2) / 1e6, 10);
    expect(result.record.reportedCostUsd).toBeUndefined();
    const chat = seen.find((s) => s.url === "https://ollama.com/v1/chat/completions");
    expect(chat?.headers.authorization).toBe(`Bearer ${KEYS.OLLAMA_API_KEY}`);
    expect(chat?.body).toMatchObject({
      model: "deepseek-v4.1-flash",
      tools: [{ type: "function" }],
    });
    const show = seen.find((s) => s.url === "https://ollama.com/api/show");
    expect(show?.body).toEqual({ model: "deepseek-v4.1-flash" });
    expect(show?.headers.authorization).toBeUndefined();
  });

  it("structured output sends the JSON schema (json_schema), not just json_object", async () => {
    const { fetch, seen } = fakeFetch((req) =>
      req.url.endsWith("/api/show")
        ? { body: ollamaShow(["tools"]) }
        : {
            body: {
              ...ollamaToolCall(),
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant", content: '{"same":true,"confidence":1}' },
                },
              ],
            },
          },
    );
    const models = createModels({ config: ollamaConfig(), sources: keySources(KEYS), fetch });
    const result = await models.complete("fixer", {
      messages: [{ role: "user", content: "Same element?" }],
      output: z.object({ same: z.boolean(), confidence: z.number() }),
    });
    expect(result.ok && result.object).toEqual({ same: true, confidence: 1 });
    const chat = seen.find((s) => s.url.endsWith("/chat/completions"));
    expect(chat?.body?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { schema: { properties: { same: { type: "boolean" } } } },
    });
    // Ollama doesn't enforce the schema for its cloud models, so the prompt says it too.
    const messages = chat?.body?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain(
      "Reply with only a JSON object that matches this JSON Schema",
    );
    expect(messages[0]?.content).toContain('"same":{"type":"boolean"}');
  });

  it("an empty answer is invalid output (retried once with the reason), not a network error", async () => {
    const { fetch } = fakeFetch((req, index) =>
      req.url.endsWith("/api/show")
        ? { body: ollamaShow(["tools"]) }
        : index === 1
          ? {
              body: {
                ...ollamaToolCall(),
                choices: [
                  {
                    index: 0,
                    finish_reason: "length",
                    message: { role: "assistant", content: "" },
                  },
                ],
              },
            }
          : {
              body: {
                ...ollamaToolCall(),
                choices: [
                  {
                    index: 0,
                    finish_reason: "stop",
                    message: { role: "assistant", content: '{"ok":true}' },
                  },
                ],
              },
            },
    );
    const models = createModels({ config: ollamaConfig(), sources: keySources(KEYS), fetch });
    const result = await models.complete("fixer", {
      messages: [{ role: "user", content: "ok?" }],
      output: z.object({ ok: z.boolean() }),
    });
    expect(result.attempts.map((a) => a.outcome)).toEqual(["invalid_output", "ok"]);
    expect(result.ok && result.object).toEqual({ ok: true });
  });

  it("a model that thinks gets room for its thinking in the output budget", async () => {
    const { fetch, seen } = fakeFetch((req) =>
      req.url.endsWith("/api/show")
        ? { body: ollamaShow(["tools", "thinking"]) }
        : { body: ollamaToolCall() },
    );
    const models = createModels({ config: ollamaConfig(), sources: keySources(KEYS), fetch });
    await models.complete("planner", { ...plannerAsk, maxOutputTokens: 500 });
    const chat = seen.find((s) => s.url.endsWith("/chat/completions"));
    expect(chat?.body?.max_tokens).toBe(4_096);
  });

  it("a model that can't call tools is skipped for the tool path, never picked silently", async () => {
    const { fetch, seen } = fakeFetch(() => ({ body: ollamaShow(["completion"]) }));
    const models = createModels({
      config: ollamaConfig("gemma4:31b"),
      sources: keySources(KEYS),
      fetch,
    });
    const result = await models.complete("planner", plannerAsk);
    expect(result).toMatchObject({ ok: false, reason: "no_provider" });
    expect(result.attempts[0]).toMatchObject({
      outcome: "skipped_unusable",
      message: "gemma4:31b can't call tools (says ollama)",
    });
    expect(seen.some((s) => s.url.endsWith("/chat/completions"))).toBe(false);
  });

  it("screenshots become a note for a model that can't read images", async () => {
    const { fetch, seen } = fakeFetch((req) =>
      req.url.endsWith("/api/show")
        ? { body: ollamaShow(["completion", "tools", "thinking"]) }
        : { body: { ...ollamaToolCall(), model: "glm-5.3" } },
    );
    const models = createModels({
      config: ollamaConfig("glm-5.3"),
      sources: keySources(KEYS),
      fetch,
    });
    const result = await models.complete("planner", {
      ...plannerAsk,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Step 1: look at the page" },
            { type: "image", data: "iVBORw0KGgo=", mediaType: "image/png" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    const chat = seen.find((s) => s.url.endsWith("/chat/completions"));
    const sent = JSON.stringify(chat?.body?.messages);
    expect(sent).not.toContain("image_url");
    expect(sent).toContain("can't read images");
  });
});

describe("limits", () => {
  it("never runs more requests at once than the provider's concurrency, and measures the wait", async () => {
    let inFlight = 0;
    let most = 0;
    const { fetch } = fakeFetch(async (req) => {
      if (req.url.endsWith("/api/show")) return { body: ollamaShow(["tools", "completion"]) };
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight--;
      return { body: ollamaToolCall() };
    });
    const models = createModels({
      config: ollamaConfig("deepseek-v4.1-flash", { concurrency: 2 }),
      sources: keySources(KEYS),
      fetch,
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => models.complete("planner", plannerAsk)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(most).toBe(2);
    expect(results.some((r) => r.record.waitMs > 0)).toBe(true);
  });

  it("defaults: openrouter 8 at once, ollama-cloud 3", async () => {
    let inFlight = 0;
    let most = 0;
    const { fetch } = fakeFetch(async (req) => {
      if (req.url.endsWith("/api/show")) return { body: ollamaShow(["tools"]) };
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return { body: ollamaToolCall() };
    });
    const models = createModels({ config: ollamaConfig(), sources: keySources(KEYS), fetch });
    await Promise.all(Array.from({ length: 7 }, () => models.complete("planner", plannerAsk)));
    expect(most).toBe(3);
  });

  it("a rate limit is waited out: the waiting event says when it resumes, the scope's clock stops", async () => {
    let clock = 1_000_000;
    const { fetch } = fakeFetch((req, index) =>
      req.url.endsWith("/api/show")
        ? { body: ollamaShow(["tools"]) }
        : index <= 2
          ? {
              status: 429,
              body: { error: { message: "too many requests" } },
              headers: { "retry-after": "45" },
            }
          : { body: ollamaToolCall() },
    );
    const waits: WaitInfo[] = [];
    const scopeEvents: WaitInfo[] = [];
    const scope = new AiWaits(
      (info) => scopeEvents.push(info),
      () => clock,
    );
    const models = createModels({
      config: ollamaConfig(),
      sources: keySources(KEYS),
      fetch,
      now: () => clock,
      onWait: (info) => waits.push(info),
      pause: async (ms) => {
        clock += ms;
        return true;
      },
    });
    const result = await withAiWaits(scope, () => models.complete("planner", plannerAsk));
    expect(result.ok).toBe(true);
    expect(result.attempts.map((a) => a.outcome)).toEqual(["rate_limited", "rate_limited", "ok"]);
    expect(result.record.waitMs).toBe(90_000);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toMatchObject({
      provider: "ollama",
      model: "deepseek-v4.1-flash",
      reason: "rate_limited",
      resumesAt: new Date(1_000_000 + 45_000).toISOString(),
    });
    expect(waits[0]?.message).toContain("resumes at");
    expect(scopeEvents).toEqual(waits);
    expect(scope.waitedMs).toBe(90_000);
    expect(scope.waiting).toBe(false);
  });

  it("a 429 without Retry-After backs off 2 s, 4 s, 8 s… and keeps the same tries", async () => {
    const slept: number[] = [];
    const { fetch } = fakeFetch((req, index) =>
      req.url.endsWith("/api/show")
        ? { body: ollamaShow(["tools"]) }
        : index <= 3
          ? { status: 429, body: { error: { message: "busy" } } }
          : { body: ollamaToolCall() },
    );
    const models = createModels({
      config: ollamaConfig(),
      sources: keySources(KEYS),
      fetch,
      pause: async (ms) => {
        slept.push(ms);
        return true;
      },
    });
    const result = await models.complete("planner", plannerAsk);
    expect(result.ok).toBe(true);
    expect(slept).toEqual([2_000, 4_000, 8_000]);
  });

  it("cancelling during a wait ends the call as aborted, not as a provider failure", async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch((req) =>
      req.url.endsWith("/api/show")
        ? { body: ollamaShow(["tools"]) }
        : { status: 429, body: {}, headers: { "retry-after": "600" } },
    );
    const models = createModels({
      config: ollamaConfig(),
      sources: keySources(KEYS),
      fetch,
      pause: async () => {
        controller.abort();
        return false;
      },
    });
    const result = await models.complete("planner", { ...plannerAsk, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, reason: "aborted" });
  });
});

describe("roles and support", () => {
  it("the drafter uses the planner's pool unless it has its own", async () => {
    const { fetch, seen } = fakeFetch((req) =>
      req.url.endsWith("/api/show") ? { body: ollamaShow(["tools"]) } : { body: ollamaToolCall() },
    );
    const models = createModels({ config: ollamaConfig(), sources: keySources(KEYS), fetch });
    expect(models.pool("drafter").map((e) => [e.role, e.provider, e.model])).toEqual([
      ["drafter", "ollama", "deepseek-v4.1-flash"],
    ]);
    const result = await models.complete("drafter", plannerAsk);
    expect(result.ok && result.record.role).toBe("drafter");
    expect(seen.filter((s) => s.url.endsWith("/chat/completions"))).toHaveLength(1);

    const own = testConfig({
      providers: { ollama: { kind: "ollama-cloud" } },
      roles: {
        planner: [{ provider: "ollama", model: "deepseek-v4.1-flash" }],
        fixer: [],
        drafter: [{ provider: "ollama", model: "glm-5.3" }],
      },
    });
    const separate = createModels({ config: own, sources: keySources(KEYS), fetch });
    expect(separate.pool("drafter").map((e) => e.model)).toEqual(["glm-5.3"]);
  });

  it("a model an eval marked unsupported for a role can't be picked, unless the entry insists", () => {
    MODEL_SUPPORT["ollama-cloud:glm-5.3"] = {
      planner: { supported: false, evidence: "EVAL-1: 9 wrong fails of 62 on the shop" },
    };
    try {
      const pools = createModels({
        config: ollamaConfig("glm-5.3"),
        sources: keySources(KEYS),
      });
      expect(pools.pool("planner")[0]).toMatchObject({ usable: false });
      expect(pools.pool("planner")[0]?.problem).toContain("marked unsupported as planner");
      expect(pools.pool("drafter")[0]?.usable).toBe(false);
      expect(pools.pool("fixer")[0]?.usable).toBe(true);
      const insisting = createModels({
        config: testConfig({
          providers: { ollama: { kind: "ollama-cloud" } },
          roles: {
            planner: [{ provider: "ollama", model: "glm-5.3", allowUnsupported: true }],
            fixer: [],
          },
        }),
        sources: keySources(KEYS),
      });
      expect(insisting.pool("planner")[0]?.usable).toBe(true);
    } finally {
      delete MODEL_SUPPORT["ollama-cloud:glm-5.3"];
    }
  });

  it("named providers find their key by its usual name and never print it", async () => {
    const logs = captureLogs();
    const { fetch } = fakeFetch((req) =>
      req.url.endsWith("/endpoints")
        ? { status: 500, body: { error: `echo ${KEYS.OPENROUTER_API_KEY}` } }
        : { status: 401, body: { error: { message: `bad key ${KEYS.OPENROUTER_API_KEY}` } } },
    );
    const records: ModelCallRecord[] = [];
    const models = createModels({
      config: openRouterConfig(),
      sources: keySources(KEYS),
      fetch,
      logger: logs.logger,
      onCall: (r) => records.push(r),
    });
    expect(models.pool("planner")[0]?.usable).toBe(true);
    const result = await models.complete("planner", plannerAsk);
    expect(result).toMatchObject({ ok: false, reason: "auth_failed" });
    const everything = JSON.stringify({ result, records }) + logs.lines.join("\n");
    expect(everything).not.toContain(KEYS.OPENROUTER_API_KEY);
  });
});
