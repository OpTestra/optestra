import { describe, expect, it } from "vitest";
import { fixture } from "./fixtures.test-support.js";
import {
  exitCodeFor,
  formatDuration,
  formatUsd,
  type Run,
  summarize,
  type Totals,
} from "./index.js";
import { readRun } from "./node/index.js";

const base = readRun(fixture("all-passed")).run as Run;
const runWith = (totals: Partial<Omit<Totals, "muted">>, blocked: Run["blocked"] = null): Run => {
  const full = { passed: 0, healed: 0, failed: 0, flaky: 0, blocked: 0, ...totals };
  const tests = Object.values(full).reduce((a, b) => a + b, 0);
  return { ...base, blocked, totals: { ...full, tests } };
};

describe("exitCodeFor and muted tests (DIA-5, 1.5)", () => {
  it("doesn't count a muted test's verdict; an unmuted failure still fails", () => {
    const [first, ...rest] = base.tests;
    if (!first) throw new Error("fixture has no tests");
    const muted: Run = {
      ...base,
      totals: { ...base.totals, passed: base.totals.passed - 1, failed: 1, muted: 1 },
      tests: [{ ...first, verdict: "failed", muted: true }, ...rest],
    };
    expect(exitCodeFor(muted, { healedCountsAsPass: false })).toBe(0);
    const unmuted: Run = { ...muted, tests: [{ ...first, verdict: "failed" }, ...rest] };
    expect(exitCodeFor(unmuted, { healedCountsAsPass: false })).toBe(1);
  });
});

describe("exitCodeFor (CLI-5)", () => {
  const configError = { reason: "config_error", message: "bad config" };
  it.each([
    ["all passed", { passed: 3 }, null, {}, 0],
    ["one failed", { passed: 2, failed: 1 }, null, {}, 1],
    ["failed beats blocked", { failed: 1, blocked: 1 }, null, {}, 1],
    ["failed beats run blocked", { failed: 1 }, configError, {}, 1],
    ["flaky fails by default", { passed: 1, flaky: 1 }, null, {}, 1],
    ["flaky allowed", { passed: 1, flaky: 1 }, null, { flakyCountsAsFailure: false }, 0],
    ["healed fails when not allowed", { healed: 1 }, null, { healedCountsAsPass: false }, 1],
    ["healed allowed", { passed: 1, healed: 1 }, null, {}, 0],
    ["healed beats blocked", { healed: 1, blocked: 1 }, null, { healedCountsAsPass: false }, 1],
    ["blocked with no failures", { passed: 2, blocked: 1 }, null, {}, 2],
    ["healed allowed + blocked", { healed: 1, blocked: 1 }, null, {}, 2],
    ["run blocked", { passed: 1 }, configError, {}, 2],
    ["no tests ran", {}, null, {}, 2],
  ] as const)("%s → %i", (_name, totals, blocked, policy, code) => {
    expect(exitCodeFor(runWith(totals, blocked), { healedCountsAsPass: true, ...policy })).toBe(
      code,
    );
  });

  it("matches the golden fixtures", () => {
    const code = (name: string) =>
      exitCodeFor(readRun(fixture(name)).run as Run, { healedCountsAsPass: false });
    expect(code("all-passed")).toBe(0);
    expect(code("android")).toBe(0);
    expect(code("failed-product-bug")).toBe(1);
    expect(code("flaky")).toBe(1);
    expect(code("healed")).toBe(1);
    expect(code("blocked-missing-secret")).toBe(2);
    expect(code("blocked-budget-exceeded")).toBe(2);
  });
});

describe("summarize", () => {
  it("counts verdicts, cost and AI calls", () => {
    const run = readRun(fixture("blocked-budget-exceeded")).run as Run;
    expect(summarize(run)).toMatchObject({
      line: "1 blocked",
      costUsd: 1.08,
      aiCalls: 4,
      unpricedCalls: 0,
    });
    expect(summarize(runWith({ passed: 2, failed: 1 })).line).toBe("2 passed, 1 failed");
    expect(summarize(runWith({})).line).toBe("no tests ran");
  });

  it("formats durations and money", () => {
    expect([formatDuration(850), formatDuration(4210), formatDuration(185_000)]).toEqual([
      "850ms",
      "4.2s",
      "3m 05s",
    ]);
    expect([formatUsd(0), formatUsd(0.0184), formatUsd(1.25)]).toEqual([
      "$0.00",
      "$0.0184",
      "$1.25",
    ]);
  });
});
