import { type FixtureMetrics, type Rate, totalMetrics } from "./metrics.js";
import type { BenchRow, FixtureId } from "./score.js";

// A Bench report (BEN-2): every number with how it was measured (guarantee 1),
// the rows behind it, and deltas against the committed baseline.

export const BENCH_REPORT_VERSION = 1;

export interface MeasuredWith {
  date: string;
  engineVersion: string;
  /** git commit of the engine, when known. */
  commit: string | null;
  os: string;
  node: string;
  reruns: number;
  /** "none (replay only, no AI)" or the model ids of a model eval. */
  models: string;
  /** The CLI command that reproduces it, without the CLI's name (e.g. `bench --reruns 10`). */
  command: string;
}

/** First runs (authoring): measured by a model eval; replay needs none. */
export interface FirstRun {
  source: string;
  model: string;
  date: string;
  tests: number;
  durationMs: number;
  aiCalls: number;
  costUsd: number;
  /** Calls through a subscription CLI (no per-call price). */
  subscriptionCalls: number;
}

export interface FixtureReport {
  status: "ran" | "skipped";
  /** Why it was skipped (no emulator, APKs not built…). */
  reason?: string;
  variants: string[];
  tests: number;
  /** Wall time per variant (first run), ms. */
  times: Record<string, number>;
  metrics?: FixtureMetrics;
  rows?: BenchRow[];
  firstRun?: FirstRun | null;
  /** How this fixture's numbers were measured (kept when a baseline merges fixtures). */
  measured?: MeasuredWith;
}

/** The decision evals (`decisions --eval`) for one backend, per task. */
export interface DecisionEvalSummary {
  backend: string;
  tasks: { task: string; cases: number; decided: number; falseLabels: number }[];
}

export interface BenchReport {
  benchVersion: typeof BENCH_REPORT_VERSION;
  measured: MeasuredWith;
  fixtures: Partial<Record<FixtureId, FixtureReport>>;
  total: ReturnType<typeof totalMetrics>;
  /** Set by the CLI's `eval`: the decision evals it ran. */
  decisions?: DecisionEvalSummary;
}

export function buildReport(
  measured: MeasuredWith,
  fixtures: Partial<Record<FixtureId, FixtureReport>>,
): BenchReport {
  const ran = Object.values(fixtures).flatMap((f) => (f?.metrics ? [f.metrics] : []));
  const stamped = Object.fromEntries(
    Object.entries(fixtures).map(([id, f]) => [
      id,
      f && f.status === "ran" && !f.measured ? { ...f, measured } : f,
    ]),
  ) as typeof fixtures;
  return {
    benchVersion: BENCH_REPORT_VERSION,
    measured,
    fixtures: stamped,
    total: totalMetrics(ran),
  };
}

// ── deltas against the baseline ───────────────────────────────────────────────

export interface Delta {
  metric: string;
  fixture: FixtureId | "total";
  baseline: number;
  now: number;
  /** Worse for the engine (more false passes, fewer replays…). */
  worse: boolean;
}

export interface BaselineComparison {
  deltas: Delta[];
  /** False passes the baseline didn't have (fixture/variant/test). */
  newFalsePasses: string[];
  /** Any rise in false passes, on a fixture both reports ran. */
  falsePassRose: boolean;
}

type Direction = "up_is_worse" | "down_is_worse";

const METRICS: { name: string; pick: (m: FixtureMetrics) => number | null; dir: Direction }[] = [
  { name: "false passes", pick: (m) => m.falsePass.count, dir: "up_is_worse" },
  { name: "false fails", pick: (m) => m.falseFail.count, dir: "up_is_worse" },
  { name: "flaky tests", pick: (m) => m.flake.count, dir: "up_is_worse" },
  { name: "needs AI (cosmetic)", pick: (m) => m.needsAi, dir: "up_is_worse" },
  { name: "other mismatches", pick: (m) => m.otherMismatches.length, dir: "up_is_worse" },
  { name: "replay hit rate", pick: (m) => m.replay.hitRate.rate, dir: "down_is_worse" },
  { name: "AI calls on correct", pick: (m) => m.replay.aiCallsOnCorrect, dir: "up_is_worse" },
  {
    name: "cosmetic steps without AI",
    pick: (m) => m.cosmetic?.noAiRate.rate ?? null,
    dir: "down_is_worse",
  },
  {
    name: "equivalence disagreements",
    pick: (m) => m.equivalence?.disagree ?? null,
    dir: "up_is_worse",
  },
];

export function compareToBaseline(now: BenchReport, baseline: BenchReport): BaselineComparison {
  const deltas: Delta[] = [];
  const newFalsePasses: string[] = [];
  let falsePassRose = false;
  for (const fixture of Object.keys(now.fixtures) as FixtureId[]) {
    const current = now.fixtures[fixture]?.metrics;
    const before = baseline.fixtures[fixture]?.metrics;
    if (!current || !before) continue;
    for (const metric of METRICS) {
      const a = metric.pick(before);
      const b = metric.pick(current);
      if (a === null || b === null || a === b) continue;
      deltas.push({
        metric: metric.name,
        fixture,
        baseline: a,
        now: b,
        worse: metric.dir === "up_is_worse" ? b > a : b < a,
      });
    }
    const known = new Set(before.falsePass.cases);
    for (const c of current.falsePass.cases)
      if (!known.has(c)) newFalsePasses.push(`${fixture}/${c}`);
    if (current.falsePass.count > before.falsePass.count) falsePassRose = true;
  }
  if (newFalsePasses.length > 0) falsePassRose = true;
  return { deltas, newFalsePasses, falsePassRose };
}

export const percent = (r: Rate, digits = 1) =>
  r.of === 0 ? "n/a" : `${(r.rate * 100).toFixed(digits)}% (${r.count}/${r.of})`;
