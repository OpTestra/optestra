import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { computeCost, priceAt, priceFor, reportedCost } from "./cost.js";

describe("prices", () => {
  it("covers every default model id", () => {
    const defaults = parse(
      readFileSync(new URL("../../config/defaults.yaml", import.meta.url), "utf8"),
    );
    const providers = defaults.models.providers as Record<string, { kind: string }>;
    // Subscription CLIs (claude-code, codex) have no price: they cost the run nothing.
    const ids = Object.values(
      defaults.models.roles as Record<string, { provider: string; model: string }[]>,
    )
      .flat()
      .filter((e) => !["claude-code", "codex"].includes(providers[e.provider]?.kind ?? ""));
    for (const e of ids) {
      const kind = providers[e.provider]?.kind ?? "";
      expect(priceAt(kind, e.model), `${kind}:${e.model}`).toBeDefined();
    }
  });

  it("computes cost with cached and cache-write tokens", () => {
    const price = { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 };
    const usage = {
      inputTokens: 1000,
      cachedInputTokens: 600,
      cacheWriteTokens: 100,
      outputTokens: 50,
    };
    expect(computeCost(usage, price)).toBeCloseTo(
      (300 * 2 + 600 * 0.2 + 100 * 2.5 + 50 * 10) / 1e6,
      12,
    );
  });

  it("returns null for unknown models and reads provider-reported cost", () => {
    expect(priceFor("never-heard-of-it")).toBeUndefined();
    expect(
      computeCost(
        { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 },
        undefined,
      ),
    ).toBeNull();
    expect(reportedCost({ usage: { cost: 0.5 } })).toBe(0.5);
    expect(reportedCost({ usage: {} })).toBeUndefined();
  });
});

describe("priceAt", () => {
  it("prefers the provider's own price, then the bare model id", () => {
    expect(priceAt("openrouter", "anthropic/claude-sonnet-5.5")).toMatchObject({
      input: 2,
      output: 10,
    });
    expect(priceAt("ollama-cloud", "kimi-k3")).toMatchObject({ input: 3, output: 15 });
    expect(priceAt("ollama-cloud", "gemma4:31b")).toMatchObject({ input: 0.14 });
    expect(priceAt("anthropic", "claude-sonnet-5-5")).toMatchObject({ input: 2 });
    expect(priceAt("openrouter", "nobody/unknown")).toBeUndefined();
    expect(
      priceAt("ollama-cloud", "kimi-k3", { "ollama-cloud:kimi-k3": { input: 1, output: 1 } }),
    ).toEqual({ input: 1, output: 1 });
  });
});
