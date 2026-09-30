import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brand } from "@testament/brand";
import type { BenchReport } from "@testament/core/bench";
import { baselinePath, type BenchCommandOptions } from "./bench.js";
import type { CommandIo } from "./config.js";

// `bench --measures` (application section 10): the success measures, from real
// data where there is some. Bench numbers come from the committed baseline
// (bench/baseline.json) and say so; the first-test time is timed now (init and
// the first run) plus authoring from the latest model eval; decision latency
// from the decision evals, now. What only the cloud or the business can
// measure is marked, never guessed.

export interface Measure {
  measure: string;
  target: string;
  /** What was measured, or null when it can't be here. */
  value: string | null;
  /** Meets the target: true/false, or null when not measured or not comparable. */
  met: boolean | null;
  /** Where the number comes from (or why there is none). */
  source: string;
}

const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

async function timeInit(url: string, io: CommandIo): Promise<number | null> {
  const { runInitCommand } = await import("./init.js");
  const dir = mkdtempSync(join(tmpdir(), "measure-init-"));
  const started = Date.now();
  try {
    const code = await runInitCommand(
      dir,
      { yes: true, name: "Measure", url, ai: "later", doctor: false },
      { cwd: dir, env: io.env, stdout: () => {} },
    );
    return code === 0 ? Date.now() - started : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function collectMeasures(io: CommandIo): Promise<Measure[]> {
  const bench = await import("@testament/core/bench");
  const shop = await bench.shopFixture();
  const file = baselinePath(shop.benchDir);
  const baseline = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as BenchReport)
    : null;
  const m = baseline?.fixtures.shop?.metrics;
  const shopMeasured = baseline?.fixtures.shop?.measured ?? baseline?.measured;
  const from = shopMeasured
    ? `bench/baseline.json, shop (${shopMeasured.date.slice(0, 10)}, ${shopMeasured.commit ?? "?"}, correct ×${shopMeasured.reruns})`
    : `no baseline: run ${brand.cliName} bench --save-baseline`;

  // Time to a first passing test: init + authoring one test + its first replay.
  const useMailpit = await bench.mailpitRunning();
  const running = await shop.module.startShop({ variant: "correct", port: 0 });
  let initMs: number | null;
  try {
    initMs = await timeInit(running.url, io);
  } finally {
    await running.stop();
  }
  const { run } = await bench.runShopVariant(shop, "correct", {
    useMailpit,
    tests: ["tests/login.test.md"],
  });
  const login = run.tests[0];
  const firstRunMs = login?.verdict === "passed" ? login.durationMs : null;
  const firstRun = bench.latestFirstRun(shop.benchDir, "shop");
  const authoringPerTest =
    firstRun && firstRun.tests > 0 ? firstRun.durationMs / firstRun.tests : null;
  const measured = initMs !== null && firstRunMs !== null && authoringPerTest !== null;
  const firstTest = (initMs ?? 0) + (firstRunMs ?? 0) + (authoringPerTest ?? 0);
  const time = (ms: number | null) => (ms === null ? "?" : s(ms));

  // Decision latency: the rules path on the committed eval sets (a run's during-run tasks).
  const { decisionEvals } = await import("./decisions.js");
  const evals = await decisionEvals({ dir: shop.dir }, io);
  const p50 = evals.ok ? Math.max(...evals.reports.map((r) => r.p50Ms)) : null;

  const smokeTests = 20;
  const perTest = m
    ? m.replay.medianMs / Math.max(1, Object.keys(shop.manifest.tests).length)
    : null;
  const rate = (r: { count: number; of: number; rate: number }) =>
    `${(r.rate * 100).toFixed(1)}% (${r.count}/${r.of})`;
  const notHere = (why: string): Pick<Measure, "value" | "met" | "source"> => ({
    value: null,
    met: null,
    source: why,
  });

  return [
    {
      measure: "Time from sign-up or download to first passing test",
      target: "Under 5 minutes",
      value: measured ? s(firstTest) : `${s(firstTest)} + parts not measured`,
      met: measured ? firstTest < 5 * 60_000 : null,
      source: `init ${time(initMs)} + authoring ${authoringPerTest === null ? "? (no model eval)" : `${s(authoringPerTest)} (per test, ${firstRun?.model} in ${firstRun?.source})`} + first run of login ${time(firstRunMs)}; installing the CLI and signing in to the AI aren't timed`,
    },
    { measure: "Cloud browser ready", target: "Under 5 seconds", ...notHere("cloud only (CLOUD)") },
    {
      measure: "Cloud Android emulator ready",
      target: "Under 60 seconds",
      ...notHere("cloud only (CLOUD)"),
    },
    {
      measure: "Replay hit rate on unchanged app",
      target: "100% (zero AI calls)",
      value: m ? `${rate(m.replay.hitRate)}, ${m.replay.aiCallsOnCorrect} AI calls` : null,
      met: m ? m.replay.hitRate.rate === 1 && m.replay.aiCallsOnCorrect === 0 : null,
      source: from,
    },
    {
      measure: "Replay hit rate after cosmetic UI changes (Bench)",
      target: "90%+ healed without re-recording",
      value: m?.cosmetic
        ? `${rate(m.cosmetic.passedWithoutRerecording)} of tests with no model; ${rate(m.cosmetic.noAiRate)} of steps without AI`
        : null,
      met: m?.cosmetic ? m.cosmetic.passedWithoutRerecording.rate >= 0.9 : null,
      source: `${from}; the misses left need the fixer model (bench --models measures it)`,
    },
    {
      measure: "False pass rate (Bench)",
      target: "Published, and under 1%",
      value: m ? rate(m.falsePass) : null,
      met: m ? m.falsePass.rate < 0.01 : null,
      source: from,
    },
    {
      measure: "PR smoke suite duration",
      target: "Under 10 minutes",
      value:
        perTest === null
          ? null
          : `≈ ${s(perTest * smokeTests)} for ${smokeTests} tests, one worker`,
      met: perTest === null ? null : perTest * smokeTests < 10 * 60_000,
      source: `projection: the shop's median replay time per test × ${smokeTests} (CI-6's 15–25), without CI setup; ${from}`,
    },
    {
      measure: "AI cost of a replay run",
      target: "$0",
      value: m ? `$${m.ai.costUsd.toFixed(2)} over every variant (${m.ai.calls} calls)` : null,
      met: m ? m.ai.costUsd === 0 : null,
      source: from,
    },
    {
      measure: "AI calls for a test on its 10th run with no app changes",
      target: "0",
      value: m ? `${m.replay.aiCallsOnCorrect} over ${m.flake.reruns} runs of correct` : null,
      met: m ? m.replay.aiCallsOnCorrect === 0 && m.flake.reruns >= 10 : null,
      source: from,
    },
    {
      measure: "Decision latency during a run",
      target: "Under 100 ms (rules or local Laya)",
      value: p50 === null ? null : `${p50 < 1 ? "under 1" : p50} ms (worst task p50, rules)`,
      met: p50 === null ? null : p50 < 100,
      source: `${brand.cliName} decisions --eval on the committed eval sets, now (decisions --bench measures a model backend)`,
    },
    {
      measure: "GitHub stars (engine repo)",
      target: "1,000 in 3 months",
      ...notHere("after launch (not an engine measure)"),
    },
    {
      measure: "Free to paid conversion",
      target: "First 20 paying teams in 2 months",
      ...notHere("after launch (not an engine measure)"),
    },
  ];
}

export async function runMeasuresCommand(
  options: BenchCommandOptions,
  io: CommandIo,
): Promise<number> {
  let measures: Measure[];
  try {
    measures = await collectMeasures(io);
  } catch (error) {
    io.stdout(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (options.json) {
    io.stdout(`${JSON.stringify({ measures }, null, 2)}\n`);
    return 0;
  }
  const rows = measures.map((m) => [
    m.met === null ? "  -" : m.met ? " ok" : "MISS",
    m.measure,
    m.target,
    m.value ?? "not measured here",
  ]);
  const widths = [4, ...[1, 2].map((i) => Math.max(...rows.map((r) => (r[i] ?? "").length)))];
  const lines = rows.map((r) =>
    [r[0]?.padEnd(4), r[1]?.padEnd(widths[1] ?? 0), r[2]?.padEnd(widths[2] ?? 0), r[3]].join("  "),
  );
  io.stdout(
    `Success measures (application section 10)\n\n${lines.join("\n")}\n\nSources:\n${measures.map((m) => `  ${m.measure}: ${m.source}`).join("\n")}\n`,
  );
  return 0;
}
