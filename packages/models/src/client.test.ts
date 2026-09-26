import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BudgetMeter } from "./budget.js";
import { createModels, type ModelsOptions } from "./client.js";
import {
  captureLogs,
  fails,
  hangs,
  KEYS,
  keySources,
  scripted,
  testConfig,
  text,
  usage,
} from "./test-kit.test-support.js";
import type { CompletionRequest, ModelCallRecord } from "./types.js";
import { MemoryUsageStore } from "./usage.js";

const ask: CompletionRequest = { messages: [{ role: "user", content: "hello" }] };

function setup(
  models: Record<string, ReturnType<typeof scripted>>,
  extra: Partial<ModelsOptions> = {},
) {
  const records: ModelCallRecord[] = [];
  const logs = captureLogs();
  const client = createModels({
    config: testConfig(),
    sources: keySources(),
    backoffMs: 0,
    logger: logs.logger,
    onCall: (record) => records.push(record),
    languageModel: (entry) => {
      const found = models[entry.provider];
      if (!found) throw new Error(`no mock for ${entry.provider}`);
      return found.model;
    },
    ...extra,
  });
  return { client, records, logs };
}

describe("complete: request types", () => {
  it("returns text with usage, cost and a call record", async () => {
    const a = scripted(text("hi there"));
    const { client, records } = setup({ a });
    const result = await client.complete("planner", { ...ask, tags: { test: "t1" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ text: "hi there", provider: "a", model: "claude-sonnet-5" });
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(result.costUsd).toBeCloseTo((100 * 2 + 20 * 10) / 1e6, 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      role: "planner",
      outcome: "ok",
      provider: "a",
      tags: { test: "t1" },
    });
    expect(JSON.parse(JSON.stringify(records[0]))).toEqual(records[0]);
  });

  it("returns tool calls", async () => {
    const a = scripted(() => ({
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "click",
          input: JSON.stringify({ ref: "e5" }),
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: usage(),
      warnings: [],
    }));
    const { client } = setup({ a });
    const result = await client.complete("planner", {
      ...ask,
      tools: [
        {
          name: "click",
          description: "Click",
          parameters: { type: "object", properties: { ref: { type: "string" } } },
        },
      ],
    });
    expect(result.ok && result.toolCalls).toEqual([
      { id: "c1", name: "click", input: { ref: "e5" } },
    ]);
  });

  it("returns a validated object for structured output", async () => {
    const a = scripted(text('{"verdict":"pass","confidence":0.9}'));
    const { client } = setup({ a });
    const result = await client.complete("planner", {
      ...ask,
      output: z.object({ verdict: z.enum(["pass", "fail"]), confidence: z.number() }),
    });
    expect(result.ok && result.object).toEqual({ verdict: "pass", confidence: 0.9 });
  });

  it("sends images as file parts and applies temperature 0 by default", async () => {
    const a = scripted(text("a button"));
    const { client } = setup({ a });
    await client.complete("planner", {
      system: "You describe screens.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", data: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" },
          ],
        },
      ],
    });
    const prompt = JSON.stringify(a.calls[0]?.prompt);
    expect(prompt).toContain('"type":"file"');
    expect(prompt).toContain('"mediaType":"image/png"');
    expect(prompt).toContain("You describe screens.");
    expect((a.calls[0] as unknown as { temperature: number }).temperature).toBe(0);
  });
});

describe("complete: failover", () => {
  it.each([
    ["429", fails(429)],
    ["5xx", fails(503)],
  ])("moves to the next entry after retries on %s", async (_label, step) => {
    const a = scripted(step);
    const b = scripted(text("from b"));
    const { client, records } = setup({ a, b });
    const result = await client.complete("planner", ask);
    expect(result.ok && result.provider).toBe("b");
    expect(a.calls).toHaveLength(3);
    expect(records[0]?.attempts.map((x) => [x.provider, x.attempt, x.outcome])).toEqual([
      ["a", 1, _label === "429" ? "rate_limited" : "server_error"],
      ["a", 2, _label === "429" ? "rate_limited" : "server_error"],
      ["a", 3, _label === "429" ? "rate_limited" : "server_error"],
      ["b", 1, "ok"],
    ]);
  });

  it("moves on after a timeout", async () => {
    const a = scripted(hangs());
    const b = scripted(text("from b"));
    const { client } = setup({ a, b });
    const result = await client.complete("planner", { ...ask, timeoutMs: 20 });
    expect(result.ok && result.provider).toBe("b");
    expect(result.attempts[0]?.outcome).toBe("timeout");
  });

  it("does not fail over on 400", async () => {
    const a = scripted(fails(400, "messages: field required"));
    const b = scripted(text("from b"));
    const { client } = setup({ a, b });
    const result = await client.complete("planner", ask);
    expect(result).toMatchObject({ ok: false, reason: "all_providers_failed" });
    expect(!result.ok && result.message).toContain("messages: field required");
    expect(b.calls).toHaveLength(0);
  });

  it("disables an entry after 401 for the rest of the run", async () => {
    const a = scripted(fails(401));
    const b = scripted(text("from b"));
    const { client } = setup({ a, b });
    expect((await client.complete("planner", ask)).ok).toBe(true);
    const second = await client.complete("planner", ask);
    expect(second.attempts[0]).toMatchObject({ provider: "a", outcome: "skipped_disabled" });
    expect(a.calls).toHaveLength(1);
    expect(client.disabled.has("a")).toBe(true);
  });

  it("returns auth_failed when every provider rejects its key", async () => {
    const { client } = setup({ a: scripted(fails(401)), b: scripted(fails(403)) });
    expect(await client.complete("planner", ask)).toMatchObject({
      ok: false,
      reason: "auth_failed",
    });
  });

  it("skips a provider at 90% of a usage cap", async () => {
    const store = new MemoryUsageStore();
    await store.record({ provider: "a", usd: 0.95, at: Date.now() - 1000 });
    const a = scripted(text("from a"));
    const b = scripted(text("from b"));
    const { client } = setup(
      { a, b },
      {
        usageStore: store,
        config: testConfig({
          providers: {
            a: {
              kind: "openai-compatible",
              baseUrl: "https://a.test/v1",
              keySecret: "A_KEY",
              caps: { per5h: { usd: 1 } },
            },
            b: { kind: "openai-compatible", baseUrl: "https://b.test/v1", keySecret: "B_KEY" },
          },
        }),
      },
    );
    const result = await client.complete("planner", ask);
    expect(result.ok && result.provider).toBe("b");
    expect(result.attempts[0]).toMatchObject({ provider: "a", outcome: "skipped_near_cap" });
    expect(a.calls).toHaveLength(0);
    expect(await store.spentSince("b", 0)).toBeGreaterThan(0);
  });

  it("retries invalid structured output once on the same entry, then moves on", async () => {
    const schema = z.object({ n: z.number() });
    const a = scripted(text('{"n":"one"}'), text('{"n":1}'));
    const { client } = setup({ a });
    const fixed = await client.complete("planner", { ...ask, output: schema });
    expect(fixed.ok && fixed.object).toEqual({ n: 1 });
    expect(JSON.stringify(a.calls[1]?.prompt)).toContain("did not match");

    const bad = scripted(text("nope"));
    const b = scripted(text('{"n":2}'));
    const second = setup({ a: bad, b });
    const moved = await second.client.complete("planner", { ...ask, output: schema });
    expect(moved.ok && moved.provider).toBe("b");
    expect(bad.calls).toHaveLength(2);
  });

  it("returns invalid_output when no entry produces valid output", async () => {
    const { client } = setup({ a: scripted(text("x")), b: scripted(text("y")) });
    expect(
      await client.complete("planner", { ...ask, output: z.object({ n: z.number() }) }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_output",
    });
  });

  it("returns no_provider when no key is available", async () => {
    const { client } = setup({}, { sources: keySources({}) });
    const result = await client.complete("planner", ask);
    expect(result).toMatchObject({ ok: false, reason: "no_provider" });
    expect(!result.ok && result.fix).toContain("API key");
  });

  it("returns aborted when the caller cancels", async () => {
    const controller = new AbortController();
    const a = scripted(hangs());
    const { client } = setup({ a });
    setTimeout(() => controller.abort(), 10);
    expect(await client.complete("planner", { ...ask, signal: controller.signal })).toMatchObject({
      ok: false,
      reason: "aborted",
    });
  });
});

describe("complete: cost and budgets", () => {
  it("a run budget of $0.01 stops the next call before calling the model", async () => {
    const config = testConfig({}, { budget: { maxPerRunUsd: 0.01 } });
    const run = BudgetMeter.forRun(config);
    const a = scripted(text("expensive", usage(5000, 0)));
    const { client } = setup({ a }, { config, budgets: [run] });
    const first = await client.complete("planner", ask);
    expect(first.ok && first.costUsd).toBeCloseTo(0.01, 10);
    const second = await client.complete("planner", ask);
    expect(second).toMatchObject({ ok: false, reason: "budget_exceeded" });
    expect(!second.ok && second.fix).toContain("run.budget.maxPerRunUsd");
    expect(a.calls).toHaveLength(1);
  });

  it("records unknown prices as null cost with a warning, never a guess", async () => {
    const b = scripted(text("ok"));
    const { client, logs } = setup({ b });
    const result = await client.complete("fixer", ask);
    expect(result.ok && result.costUsd).toBeNull();
    expect(
      logs.lines.some((line) => line.startsWith("warn No price known for model mystery-model")),
    ).toBe(true);
  });

  it("uses project price overrides", async () => {
    const b = scripted(text("ok"));
    const config = testConfig({ prices: { "mystery-model": { input: 1, output: 1 } } });
    const { client } = setup({ b }, { config });
    const result = await client.complete("fixer", ask);
    expect(result.ok && result.costUsd).toBeCloseTo(120 / 1e6, 12);
  });
});

describe("keys never leak", () => {
  it("scrubs a key echoed by the provider from results, records and logs", async () => {
    const a = scripted(fails(401, `invalid x-api-key ${KEYS.A_KEY}`));
    const b = scripted(fails(400, `bad request for key ${KEYS.B_KEY}`));
    const { client, records, logs } = setup({ a, b });
    const result = await client.complete("planner", ask);
    const everything = JSON.stringify({ result, records }) + logs.lines.join("\n");
    expect(everything).not.toContain(KEYS.A_KEY);
    expect(everything).not.toContain(KEYS.B_KEY);
    expect(everything).toContain("[secret:A_KEY]");
  });
});
