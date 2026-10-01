import type { ModelCall } from "@optestra/contract";
import { describe, expect, it } from "vitest";
import { add, complexityOf, none, summarize, totals } from "./comparison.js";

// EVAL-0's arithmetic: list-price costs (also for subscription calls), the
// summaries and the complexity classes the pricing numbers are grouped by.

const call = (
  model: string,
  tokens: Partial<ModelCall["tokens"]>,
  extra: Partial<ModelCall> = {},
): ModelCall => ({
  id: `c-${Math.random()}`,
  role: "planner",
  provider: "claude-code",
  model,
  startedAt: "2026-10-01T00:00:00.000Z",
  tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0, ...tokens },
  costUsd: 0,
  latencyMs: 1000,
  attempts: 1,
  outcome: "ok",
  billing: "subscription",
  ...extra,
});

describe("list-price totals", () => {
  it("prices subscription calls at list prices, cache reads and writes included", () => {
    // claude-sonnet-5-5: $2 in, $0.20 cache read, $2.50 cache write, $10 out per M.
    const t = totals(
      [
        call("claude-sonnet-5-5", {
          input: 1_000_000,
          cached: 400_000,
          cacheWrite: 100_000,
          output: 10_000,
        }),
      ],
      "x",
    );
    expect(t.listUsd).toBeCloseTo(0.5 * 2 + 0.4 * 0.2 + 0.1 * 2.5 + 0.01 * 10, 10);
    expect(t).toMatchObject({ calls: 1, subscriptionCalls: 1, latencyMs: 1000 });
  });

  it("uses the entry's model when a call names none, and says unknown when a price is", () => {
    expect(
      totals([call(null as never, { input: 1_000_000 }, { model: null })], "gpt-6-luna").listUsd,
    ).toBeCloseTo(0.1, 10);
    expect(totals([call("no-such-model", { input: 10 })], "no-such-model").listUsd).toBeNull();
    expect(add(none(), totals([call("no-such-model", { input: 10 })], "x")).listUsd).toBeNull();
  });

  it("adds totals", () => {
    const a = totals([call("claude-sonnet-4-6", { input: 100, output: 10 })], "x");
    expect(add(a, a)).toMatchObject({ calls: 2, tokens: { input: 200, output: 20 } });
  });
});

describe("summaries and classes", () => {
  it("summarizes with nearest-rank percentiles", () => {
    expect(summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({
      n: 10,
      mean: 5.5,
      p50: 5,
      p90: 9,
      max: 10,
    });
    expect(summarize([])).toEqual({ n: 0, mean: 0, p50: 0, p90: 0, max: 0 });
  });

  it("classes tests as the brief does: simple, medium (a login), complex (long, email, upload, matrix)", () => {
    const t = { steps: 4, login: false, email: false, upload: false, matrix: false };
    expect(complexityOf(t)).toBe("simple");
    expect(complexityOf({ ...t, login: true })).toBe("medium");
    expect(complexityOf({ ...t, steps: 8 })).toBe("medium");
    expect(complexityOf({ ...t, steps: 11 })).toBe("complex");
    expect(complexityOf({ ...t, email: true })).toBe("complex");
    expect(complexityOf({ ...t, upload: true })).toBe("complex");
  });
});
