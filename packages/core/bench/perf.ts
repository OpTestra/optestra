// perf (PERF-0): how fast replay is next to the same tests as plain Playwright.
//
//   node packages/core/bench/perf.ts [--runs 5] [--variant correct] [--evidence full|failures|minimal] [--steps] [--json out.json]
//
// Runs the shop's tests `--runs` times each way: the replay (no AI, one worker,
// video off like bench:replay) and the generated specs (Playwright Test, one
// worker). Reports the median and p95 per test and in total. Tests the plain
// specs can't run here (email tests without Mailpit) are left out of both
// sides. `--steps` adds where the replay's time went, per step kind.

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { TestResult } from "@testament/contract";
import { VARIANTS, type Variant } from "@testament/fixture-shop";
import { mailpitRunning, replayShop, specShop } from "./shop.ts";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    variant: { type: "string", default: "correct" },
    evidence: { type: "string" },
    steps: { type: "boolean" },
    json: { type: "string" },
  },
});
const runs = Math.max(1, Number(values.runs));
const variant = values.variant as Variant;
if (!VARIANTS.includes(variant)) throw new Error(`unknown variant ${variant}`);
const evidence = values.evidence as "full" | "failures" | "minimal" | undefined;
const useMailpit = await mailpitRunning();

const quantile = (list: readonly number[], q: number) => {
  const sorted = [...list].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
};
const median = (list: readonly number[]) => quantile(list, 0.5);
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

const replayTimes = new Map<string, number[]>();
const specTimes = new Map<string, number[]>();
const replayTotals: number[] = [];
const specTotals: number[] = [];
const verdicts = new Map<string, Set<string>>();
const stepTime: Record<string, { ms: number; settled: number; count: number }> = {};

for (let i = 0; i < runs; i++) {
  const { run } = await replayShop(variant, {
    useMailpit,
    ...(evidence ? { evidence } : {}),
  });
  const spec = await specShop(variant, useMailpit);
  // Both sides compare the same tests: those the plain specs could run.
  const compared = run.tests.filter((t: TestResult) => spec.verdicts[t.name] !== "blocked");
  let replayTotal = 0;
  let specTotal = 0;
  for (const test of compared) {
    const name = test.file;
    replayTimes.set(name, [...(replayTimes.get(name) ?? []), test.durationMs]);
    specTimes.set(name, [...(specTimes.get(name) ?? []), spec.durations[test.name] ?? 0]);
    replayTotal += test.durationMs;
    specTotal += spec.durations[test.name] ?? 0;
    verdicts.set(name, new Set([...(verdicts.get(name) ?? []), test.verdict]));
    for (const attempt of test.attempts)
      for (const step of attempt.steps) {
        const entry = stepTime[step.kind] ?? { ms: 0, settled: 0, count: 0 };
        stepTime[step.kind] = entry;
        entry.ms += step.durationMs;
        entry.settled += step.settledMs ?? 0;
        entry.count++;
      }
  }
  replayTotals.push(replayTotal);
  specTotals.push(specTotal);
  process.stdout.write(
    `run ${i + 1}/${runs}: replay ${seconds(replayTotal)}, specs ${seconds(specTotal)} (${compared.length} tests)\n`,
  );
}

const rows = [...replayTimes.keys()].map((test) => {
  const replay = replayTimes.get(test) ?? [];
  const spec = specTimes.get(test) ?? [];
  return {
    test,
    verdicts: [...(verdicts.get(test) ?? [])],
    replay: { median: median(replay), p95: quantile(replay, 0.95) },
    spec: { median: median(spec), p95: quantile(spec, 0.95) },
  };
});
const total = {
  replay: { median: median(replayTotals), p95: quantile(replayTotals, 0.95) },
  spec: { median: median(specTotals), p95: quantile(specTotals, 0.95) },
};
const ratio = total.spec.median > 0 ? total.replay.median / total.spec.median : 0;

process.stdout.write(
  `\n${"test".padEnd(38)} ${"replay med".padStart(10)} ${"p95".padStart(8)} ${"spec med".padStart(10)} ${"p95".padStart(8)}  ratio\n`,
);
for (const row of rows)
  process.stdout.write(
    `${row.test.padEnd(38)} ${seconds(row.replay.median).padStart(10)} ${seconds(row.replay.p95).padStart(8)} ${seconds(row.spec.median).padStart(10)} ${seconds(row.spec.p95).padStart(8)}  ${(row.replay.median / Math.max(1, row.spec.median)).toFixed(2)}×${row.verdicts.join(",") === "passed" ? "" : `  ${row.verdicts.join(",")}`}\n`,
  );
process.stdout.write(
  `${"total".padEnd(38)} ${seconds(total.replay.median).padStart(10)} ${seconds(total.replay.p95).padStart(8)} ${seconds(total.spec.median).padStart(10)} ${seconds(total.spec.p95).padStart(8)}  ${ratio.toFixed(2)}×\n`,
);
if (values.steps) {
  process.stdout.write("\nReplay time per step kind (all runs):\n");
  for (const [kind, entry] of Object.entries(stepTime))
    process.stdout.write(
      `  ${kind.padEnd(8)} ${entry.count} steps, ${seconds(entry.ms / runs)} per run, settling ${seconds(entry.settled / runs)}, ${Math.round(entry.ms / entry.count)} ms per step\n`,
    );
}
if (values.json)
  writeFileSync(
    values.json,
    `${JSON.stringify({ variant, runs, evidence: evidence ?? null, rows, total, ratio }, null, 2)}\n`,
  );
