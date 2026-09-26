import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { type PriceSettings, priceSchema } from "./config.js";
import type { TokenUsage } from "./types.js";

let table: Record<string, PriceSettings> | undefined;

/** The shipped price table (prices.yaml), validated. */
export function basePrices(): Record<string, PriceSettings> {
  if (!table) {
    const text = readFileSync(new URL("../prices.yaml", import.meta.url), "utf8");
    table = z.record(z.string(), priceSchema).parse(parse(text) ?? {});
  }
  return table;
}

/** Price for a model id: project override first, then the shipped table. */
export function priceFor(
  model: string,
  overrides: Record<string, PriceSettings> = {},
): PriceSettings | undefined {
  return overrides[model] ?? basePrices()[model];
}

/** USD for the usage, or null when the price is unknown. */
export function computeCost(usage: TokenUsage, price: PriceSettings | undefined): number | null {
  if (!price) return null;
  const uncached = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens,
  );
  const usd =
    uncached * price.input +
    usage.cachedInputTokens * (price.cachedInput ?? price.input) +
    usage.cacheWriteTokens * (price.cacheWrite ?? price.input) +
    usage.outputTokens * price.output;
  return usd / 1_000_000;
}

/** Cost the provider reported in its response body (e.g. OpenRouter's `usage.cost`). */
export function reportedCost(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const usage = (body as { usage?: { cost?: unknown } }).usage;
  return typeof usage?.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : undefined;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
