import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assembleBaseline, formatCostBaseline, type VmRun } from "./baseline.js";
import type { CorpusFile, CorpusStyleResult } from "./corpus.js";
import { type CostMeasurement, loadCloudPrices, meterReport } from "./cost.js";

// The baseline as the growth team reads it: the meter on the committed local
// rehearsal, plus a small corpus and two Android VM runs written here, so each
// number is checked against arithmetic done by hand.

const cloud = new URL("../../../../bench/cloud/", import.meta.url);
const prices = loadCloudPrices(fileURLToPath(new URL("prices.yaml", cloud)));
const resultsDir = new URL("testdata/rehearsal-local/results/", cloud);
const measurements = readdirSync(resultsDir)
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, resultsDir), "utf8")) as CostMeasurement);
const meter = meterReport(measurements, prices, {
  costRun: "rehearsal-local",
  date: "2026-10-03T00:00:00.000Z",
  command: "bench --meter",
  engineVersion: "0.1.0",
  commit: null,
  buildMinutes: null,
  imageGiB: null,
});

const totals = (calls: number, listUsd: number) => ({
  calls,
  tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 },
  listUsd,
  subscriptionCalls: 0,
  latencyMs: 0,
});
const rate = (count: number, of: number) => ({ count, of, rate: of ? count / of : 0, cases: [] });

function style(
  name: string,
  route: "file" | "description",
  entries: Array<[string, number, number]>,
): CorpusStyleResult {
  const ai = entries.reduce((n, [, , usd]) => n + usd, 0);
  const draft = route === "description" ? 0.008 * entries.length : 0;
  return {
    fixture: "shop",
    style: name,
    route,
    entries: entries.length,
    lint: { clean: entries.length, warnings: 0, rejected: 0, reasons: {} },
    phrases: { expects: 0, byRules: 0, unmarkedChecks: 0 },
    drafts: {
      drafts: route === "description" ? entries.length : 0,
      ok: 0,
      lintClean: 0,
      ...totals(route === "description" ? 15 * entries.length : 0, draft),
      wallMs: 0,
    },
    authoring: {
      tests: entries.length,
      passed: entries.length - 1,
      wallMs: 60_000,
      ...totals(
        entries.reduce((n, [, c]) => n + c, 0),
        ai,
      ),
    },
    falsePass: rate(0, 15),
    falseFail: rate(name === "spoken" ? 5 : 1, 73),
    otherMismatches: [],
    cosmetic: {
      tests: 2,
      passedOrHealed: 2,
      healedByFixer: 1,
      healsWithoutAi: 3,
      needsAi: 0,
      ...totals(4, 0.002),
    },
    total: { ...totals(0, 0), wallMs: 120_000 },
    perEntry: entries.map(([gold, calls, usd]) => ({
      gold,
      lint: {
        status: "clean",
        reasons: [],
        steps: 5,
        expects: 2,
        guards: 0,
        expectsByRules: 2,
        unmarkedChecks: 0,
      },
      draft:
        route === "description"
          ? { status: "ok", lintClean: true, calls: 15, listUsd: 0.008, wallMs: 1 }
          : null,
      authored: "passed",
      authoring: { ...totals(calls, usd), wallMs: 1 },
      variants: {},
    })),
    problem: null,
  };
}

const corpus: CorpusFile = {
  corpusVersion: 1,
  kind: "corpus",
  date: "2026-10-03T00:00:00.000Z",
  engineVersion: "0.1.0",
  commit: null,
  os: "test",
  scripted: false,
  model: "ollama-cloud:deepseek-v4.1-flash",
  command: "bench --corpus",
  measured: [],
  styles: [
    style("tidy", "file", [
      ["login", 10, 0.002],
      ["create-project", 14, 0.004],
    ]),
    style("spoken", "description", [
      ["login", 12, 0.003],
      ["create-project", 16, 0.005],
    ]),
  ],
};

const vm = (fromImage: boolean, setupMs: number | null): VmRun => ({
  kind: "android-vm-run",
  vm: {
    machineType: "n2-standard-4",
    zone: "us-east4-b",
    fromReusableImage: fromImage,
    diskGb: 30,
    image: "x",
  },
  phases: { createMs: 17_000, sshReadyMs: 40_000, setupMs, buildMs: 60_000, commandMs: 1_800_000 },
  command: "pnpm bench:replay:android",
  exit: 0,
  preempted: false,
  replay: {
    summary: { tests: 50, match: 48, healed: 0, needsAi: 1, mismatch: 1, aiCalls: 0 },
    wallMsPerTest: { p50: 18_000, mean: 19_000 },
    evidenceBytes: { total: 0, perTest: 0 },
    mismatches: [],
  },
  cost: { vmSeconds: 1_800 + 117 + (setupMs ?? 0) / 1000, hourlyUsd: 0.0576, usd: null },
});

const baseline = assembleBaseline({
  cloud: meter,
  corpus: [corpus],
  vmRuns: [vm(false, 420_000), vm(true, null), { ...vm(true, null), replay: null }],
  measurements,
  prices,
  complexity: { login: "medium", "create-project": "complex" },
  ai: { offPeakFactor: 0.5, offPeakWindow: "weekends" },
  idle: {
    staging: { minInstances: 0, vcpu: 1, memoryGiB: 1 },
    reaper: {
      invocationsPerMonth: 4383,
      secondsPerInvocation: 1,
      vcpu: 1,
      memoryGiB: 0.25,
      schedulerJobs: 1,
    },
    registryGiB: 0.25,
    images: [{ name: "android-vm-x", gib: 7.44, ttlMinutes: 10080 }],
  },
});

describe("the cost baseline", () => {
  it("prices authoring per style, drafting included for descriptions", () => {
    const tidy = baseline.styles.find((s) => s.style === "tidy");
    const spoken = baseline.styles.find((s) => s.style === "spoken");
    expect(tidy?.perTest).toMatchObject({ calls: 12, aiUsd: 0.003, aiOffPeakUsd: 0.0015 });
    // (0.003 + 0.005 authoring + 2 × 0.008 drafts) / 2 tests
    expect(spoken?.perTest.aiUsd).toBeCloseTo(0.012, 9);
    expect(spoken?.perTest.calls).toBe((12 + 16 + 30) / 2);
    expect(spoken?.wrongFails).toBe("5/73");
    expect(tidy?.heal).toMatchObject({ calls: 2, aiUsd: 0.001 });
  });

  it("averages per complexity across styles", () => {
    const medium = baseline.perComplexity.find((p) => p.complexity === "medium");
    const complex = baseline.perComplexity.find((p) => p.complexity === "complex");
    expect(medium?.tests).toBe(2);
    expect(medium?.aiUsd).toBeCloseTo((0.002 + 0.003 + 0.008) / 2, 9);
    expect(complex?.aiUsd).toBeCloseTo((0.004 + 0.005 + 0.008) / 2, 9);
  });

  it("prices Android cold vs from the image, flakiness apart", () => {
    const perHour = 0.0576 + (30 * 0.11) / 730;
    const [cold, image] = baseline.android.paths;
    expect(baseline.android.paths).toHaveLength(2); // the command-only run (no replay) isn't a path
    expect(cold?.path).toBe("cold");
    expect(cold?.perTestAllIn).toBeCloseTo(((2337 / 3600) * perHour) / 50, 6);
    expect(image?.perTestAllIn).toBeCloseTo(((1917 / 3600) * perHour) / 50, 6);
    expect(image?.perTestMarginal).toBeCloseTo(((1800 / 3600) * perHour) / 50, 6);
    expect(cold?.flakiness).toMatchObject({ match: 48, mismatch: 1, needsAi: 1, tests: 50 });
  });

  it("finds the cheapest shape that keeps the verdicts and CI-6's 10 minutes", () => {
    expect(baseline.cheapestGoodShape?.shape).toBeDefined();
    const shape = meter.shapes.find((s) => s.shape === baseline.cheapestGoodShape?.shape);
    expect(shape?.good).toBe(true);
    expect(shape?.twentyTestsSeconds ?? 999).toBeLessThanOrEqual(600);
    for (const s of meter.shapes.filter((x) => x.good))
      expect(baseline.cheapestGoodShape?.runOf20Usd ?? 0).toBeLessThanOrEqual(
        s.perRun.find((r) => r.tests === 20 && r.phase === "replay")?.usd ?? 0,
      );
  });

  it("adds up the idle month: staging at zero, the reaper, the image", () => {
    const item = (name: string) =>
      baseline.idleMonthly.items.find((i) => i.item.startsWith(name))?.usd;
    expect(item("Staging")).toBe(0);
    // 4,383 s × (1 × $0.000024 + 0.25 × $0.0000025) + 4,383 requests × $0.40/M; one scheduler job is free.
    expect(item("VM reaper")).toBeCloseTo(4383 * (0.000024 + 0.25 * 0.0000025) + 0.004383 * 0.4, 4);
    expect(item("Android image")).toBeCloseTo(7.44 * 0.055, 4);
    expect(item("Artifact Registry")).toBe(0);
  });

  it("states the AI at list and off-peak", () => {
    expect(baseline.ai.offPeakUsd).toBeCloseTo(baseline.ai.listUsd / 2, 9);
    expect(formatCostBaseline(baseline)).toContain("off-peak");
  });
});
