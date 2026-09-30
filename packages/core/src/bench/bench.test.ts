import { describe, expect, it } from "vitest";
import { formatBench } from "./format.js";
import { evalGate } from "./gate.js";
import { fixtureMetrics, isFalseFail, isFalsePass, totalMetrics } from "./metrics.js";
import { type BenchReport, buildReport, compareToBaseline, percent } from "./report.js";
import { type BenchRow, type Manifest, scoreResult, stepStats } from "./score.js";

// The BEN-2 definitions, pinned on synthetic results (no browser): what a
// false pass, a false fail and a flake are, and how the gate reads a rise.

const steps = (ran: number, replayed = ran, refound = 0) => ({
  ran,
  replayed,
  refound,
  byFixer: 0,
  authored: 0,
});

function row(fields: Partial<BenchRow> & { variant: string; test: string }): BenchRow {
  const expectedVerdict = fields.expected?.verdict ?? "passed";
  return {
    fixture: "shop",
    rerun: 1,
    expected: { verdict: expectedVerdict },
    verdict: expectedVerdict,
    cause: null,
    step: null,
    score: "match",
    note: "",
    aiCalls: 0,
    costUsd: 0,
    heals: { withoutAi: 0, needsAi: 0 },
    steps: steps(4),
    durationMs: 1000,
    ...fields,
  };
}

const MEASURED = {
  date: "2026-09-30T00:00:00.000Z",
  engineVersion: "0.1.0",
  commit: "abc1234",
  os: "test",
  node: "v24",
  reruns: 3,
  models: "none (replay only, no AI)",
  command: "testament bench --reruns 3",
};

/** A shop run: 2 tests × correct (3 runs), cosmetic, and a broken variant that must fail. */
function sample(overrides: Partial<Record<string, Partial<BenchRow>>> = {}): BenchRow[] {
  const rows = [
    ...[1, 2, 3].flatMap((rerun) => [
      row({ variant: "correct", test: "login", rerun, ...overrides[`correct/login/${rerun}`] }),
      row({ variant: "correct", test: "sort", rerun, ...overrides[`correct/sort/${rerun}`] }),
    ]),
    row({
      variant: "cosmetic",
      test: "login",
      verdict: "healed",
      score: "healed",
      heals: { withoutAi: 1, needsAi: 0 },
      steps: steps(4, 3, 1),
      ...overrides["cosmetic/login"],
    }),
    row({
      variant: "cosmetic",
      test: "sort",
      verdict: "blocked",
      score: "needs_ai",
      heals: { withoutAi: 0, needsAi: 1 },
      steps: steps(2, 1, 0),
      ...overrides["cosmetic/sort"],
    }),
    row({
      variant: "broken-total",
      test: "login",
      expected: { verdict: "failed", cause: "product_bug" },
      verdict: "failed",
      cause: "product_bug",
      ...overrides["broken-total/login"],
    }),
    row({ variant: "broken-total", test: "sort", ...overrides["broken-total/sort"] }),
  ];
  return rows;
}

describe("metric definitions (BEN-2)", () => {
  it("a false pass: must not pass (failed, flaky, blocked), and passed or healed", () => {
    for (const expected of ["failed", "flaky", "blocked"])
      for (const verdict of ["passed", "healed"])
        expect(isFalsePass({ expected: { verdict: expected }, verdict })).toBe(true);
    expect(isFalsePass({ expected: { verdict: "failed" }, verdict: "failed" })).toBe(false);
    expect(isFalsePass({ expected: { verdict: "failed" }, verdict: "blocked" })).toBe(false);
    expect(isFalsePass({ expected: { verdict: "passed" }, verdict: "passed" })).toBe(false);
  });

  it("a false fail: must pass, ended failed or blocked; a no-model 'needs AI' miss is not one", () => {
    expect(
      isFalseFail({ expected: { verdict: "passed" }, verdict: "failed", score: "mismatch" }),
    ).toBe(true);
    expect(
      isFalseFail({ expected: { verdict: "passed" }, verdict: "blocked", score: "mismatch" }),
    ).toBe(true);
    expect(
      isFalseFail({ expected: { verdict: "passed" }, verdict: "blocked", score: "needs_ai" }),
    ).toBe(false);
    expect(
      isFalseFail({ expected: { verdict: "passed" }, verdict: "flaky", score: "mismatch" }),
    ).toBe(false);
    expect(
      isFalseFail({ expected: { verdict: "failed" }, verdict: "failed", score: "match" }),
    ).toBe(false);
  });

  it("rates use first runs; counts are kept next to every rate", () => {
    const m = fixtureMetrics(sample());
    expect(m.scored).toBe(6);
    expect(m.falsePass).toMatchObject({ count: 0, of: 1, rate: 0 });
    // correct ×2, cosmetic login, broken-total sort must pass; cosmetic sort needs AI.
    expect(m.falseFail).toMatchObject({ count: 0, of: 5 });
    expect(m.needsAi).toBe(1);
    expect(percent(m.falsePass)).toBe("0.0% (0/1)");
  });

  it("counts a planted false pass, and names it", () => {
    const m = fixtureMetrics(
      sample({ "broken-total/login": { verdict: "passed", cause: null, score: "mismatch" } }),
    );
    expect(m.falsePass).toMatchObject({ count: 1, of: 1, rate: 1, cases: ["broken-total/login"] });
    expect(m.otherMismatches).toEqual([]);
  });

  it("flake: a test is flaky when any rerun is flaky or its reruns disagree", () => {
    const steady = fixtureMetrics(sample());
    expect(steady.flake).toMatchObject({ count: 0, of: 2, reruns: 3, flakyRuns: 0 });
    const flaky = fixtureMetrics(
      sample({
        "correct/login/2": { verdict: "flaky" },
        "correct/sort/3": { verdict: "failed", score: "mismatch" },
      }),
    );
    expect(flaky.flake).toMatchObject({ count: 2, of: 2, flakyRuns: 1 });
    expect(flaky.flake.cases.sort()).toEqual(["login", "sort"]);
    // Reruns never count toward the false fail rate.
    expect(flaky.falseFail.count).toBe(0);
  });

  it("replay hit rate on correct, and what cosmetic did without AI", () => {
    const m = fixtureMetrics(sample({ "correct/login/1": { steps: steps(4, 3, 1) } }));
    expect(m.replay.hitRate).toMatchObject({ count: 7, of: 8 });
    expect(m.cosmetic?.hitRate).toMatchObject({ count: 4, of: 6 });
    expect(m.cosmetic?.noAiRate).toMatchObject({ count: 5, of: 6 });
    expect(m.cosmetic?.passedWithoutRerecording).toMatchObject({ count: 1, of: 2 });
    expect(m.cosmetic?.healsWithoutAi).toBe(1);
    expect(m.replay.medianMs).toBe(2000);
  });

  it("equivalence counts disagreements; totals add counts across fixtures", () => {
    const shop = fixtureMetrics(sample(), [
      { variant: "correct", test: "login", agree: true },
      { variant: "correct", test: "sort", agree: false },
    ]);
    expect(shop.equivalence).toEqual({ compared: 2, disagree: 1, cases: ["correct/sort"] });
    const android = fixtureMetrics(
      sample({ "broken-total/login": { verdict: "passed", score: "mismatch" } }),
    );
    const total = totalMetrics([shop, android]);
    expect(total.falsePass).toMatchObject({ count: 1, of: 2, rate: 0.5 });
    expect(total.needsAi).toBe(2);
  });
});

describe("scoring against the manifest", () => {
  const manifest: Manifest = {
    variants: { cosmetic: { also_accept: { passed: ["healed"] } } },
    tests: {},
    harness: { retries: 1 },
  };
  const result = (verdict: string, extra: Record<string, unknown> = {}) =>
    ({ verdict, failureCause: null, decidedBy: [], headline: null, ...extra }) as never;

  it("accepts healed on cosmetic, checks the cause, and marks AI-only misses", () => {
    const none = { withoutAi: 0, needsAi: 0 };
    expect(
      scoreResult(manifest, "cosmetic", { verdict: "passed" }, result("healed"), {
        withoutAi: 2,
        needsAi: 0,
      }).score,
    ).toBe("healed");
    expect(
      scoreResult(
        manifest,
        "broken-total",
        { verdict: "failed", cause: "product_bug" },
        result("failed", { failureCause: "test_drift" }),
        none,
      ).score,
    ).toBe("mismatch");
    expect(
      scoreResult(manifest, "cosmetic", { verdict: "passed" }, result("failed"), {
        withoutAi: 0,
        needsAi: 1,
      }).score,
    ).toBe("needs_ai");
  });

  it("counts steps by how they got done, final attempt only", () => {
    const step = (recovery: string, extra: Record<string, unknown> = {}) => ({
      kind: "action",
      status: "passed",
      recovery,
      modelCallIds: [],
      ...extra,
    });
    const stats = stepStats({
      attempts: [
        { steps: [step("none")] },
        {
          steps: [
            step("replay"),
            step("refind"),
            step("fixer"),
            step("none", { modelCallIds: ["m1"] }),
            step("none", { kind: "expect" }),
            step("replay", { status: "skipped" }),
          ],
        },
      ],
    } as never);
    expect(stats).toEqual({ ran: 4, replayed: 1, refound: 1, byFixer: 1, authored: 1 });
  });
});

describe("baseline and gate (LRN-10)", () => {
  const report = (rows: BenchRow[]): BenchReport =>
    buildReport(MEASURED, {
      shop: { status: "ran", variants: [], tests: 2, times: {}, metrics: fixtureMetrics(rows) },
    });

  it("shows deltas against the baseline, marking what got worse", () => {
    const before = report(sample());
    const after = report(sample({ "correct/login/1": { steps: steps(4, 2, 2) } }));
    const cmp = compareToBaseline(after, before);
    expect(cmp.falsePassRose).toBe(false);
    expect(cmp.deltas).toEqual([
      { metric: "replay hit rate", fixture: "shop", baseline: 1, now: 0.75, worse: true },
    ]);
    expect(formatBench(after, cmp)).toContain("WORSE  shop replay hit rate: 100.0% → 75.0%");
  });

  it("the gate fails on a planted false pass, and passes on the same numbers", () => {
    const baseline = report(sample());
    const same = evalGate({ bench: { now: report(sample()), baseline } });
    expect(same).toMatchObject({ passed: true, exitCode: 0 });
    const planted = evalGate({
      bench: {
        now: report(sample({ "broken-total/login": { verdict: "passed", score: "mismatch" } })),
        baseline,
      },
    });
    expect(planted.exitCode).toBe(1);
    expect(planted.lines.join("\n")).toMatch(
      /false passes rose: 0 → 1 \(new: shop\/broken-total\/login\)/,
    );
  });

  it("the gate fails without a baseline (no evidence) and on more false labels", () => {
    expect(evalGate({ bench: { now: report(sample()), baseline: null } }).exitCode).toBe(1);
    const decisions = (falseLabels: number) => ({
      backend: "jev",
      tasks: [{ task: "failure_cause", cases: 10, decided: 9, falseLabels }],
    });
    expect(evalGate({ decisions: { now: decisions(0), baseline: decisions(0) } }).exitCode).toBe(0);
    expect(evalGate({ decisions: { now: decisions(1), baseline: decisions(0) } }).exitCode).toBe(1);
    expect(
      evalGate({ models: { now: [{ model: "openrouter:x", falsePasses: 1 }], baseline: 0 } })
        .exitCode,
    ).toBe(1);
    expect(evalGate({}).exitCode).toBe(1);
  });

  it("the table never rounds a false pass away", () => {
    const text = formatBench(
      report(sample({ "broken-total/login": { verdict: "passed", score: "mismatch" } })),
    );
    expect(text).toContain("False pass rate (headline)");
    expect(text).toContain("100.0% (1/1)");
    expect(text).toContain("FALSE PASS  broken-total/login");
    expect(text).toContain("reproduce: testament bench --reruns 3");
  });
});
