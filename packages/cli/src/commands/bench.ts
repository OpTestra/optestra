import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandIo } from "./config.js";

// `bench` (BEN-2): scores the engine on the repository's Bench fixtures and
// compares with the committed baseline (bench/baseline.json). Exit 1 when the
// engine got worse on what must never get worse (false passes, false fails,
// wrong verdicts, replay vs spec, AI on an unchanged app); 2 when Bench can't
// run here. Flake and hit-rate changes are reported, not gated (they're noisy).

export interface BenchCommandOptions {
  fixture?: string;
  reruns?: string;
  variant?: string[];
  json?: boolean;
  equivalence?: boolean;
  /** Write this run as the new committed baseline. */
  saveBaseline?: boolean;
  /** Model evals (MOD-9): pool entries like claude-code:claude-sonnet-5-5. */
  models?: string[];
  /** Model evals without real models (CI). */
  scripted?: boolean;
  /** Print the section-10 success measures. */
  measures?: boolean;
  /** For --models: say yes to the real-model run without asking. */
  yes?: boolean;
  /** EVAL-0: compare these models (pool entries) and measure the cost facts. */
  compare?: string[];
  /** For --compare: AI budget per model, USD. */
  modelBudget?: number;
  /** COST-0: run the real-developer corpus (bench/corpus). */
  corpus?: boolean;
  /** For --corpus: only lint and the phrase rules (no browser, no model). */
  static?: boolean;
  /** For --corpus: only these styles / gold tests / this route. */
  style?: string[];
  test?: string[];
  route?: string;
  /** For --corpus: `--no-cosmetic` skips the cosmetic heal pass. */
  cosmetic?: boolean;
  /** COST-0: turn cloud measurements into the cost report. */
  meter?: string;
  /** For --meter: where to write the report (default bench/results). */
  out?: string;
}

const GATED = new Set([
  "false passes",
  "false fails",
  "other mismatches",
  "equivalence disagreements",
  "AI calls on correct",
]);

export function baselinePath(benchDir: string): string {
  return join(benchDir, "baseline.json");
}

export async function runBenchCommand(
  options: BenchCommandOptions,
  io: CommandIo & { signal?: AbortSignal },
): Promise<number> {
  const fixture = options.fixture ?? "shop";
  if (!["shop", "android", "all"].includes(fixture)) {
    io.stdout(`--fixture must be shop, android or all, not "${fixture}".\n`);
    return 2;
  }
  const reruns = options.reruns === undefined ? 10 : Number(options.reruns);
  if (!Number.isInteger(reruns) || reruns < 1) {
    io.stdout(`--reruns must be a whole number of 1 or more, not "${options.reruns}".\n`);
    return 2;
  }
  if (options.corpus) {
    const { runCorpusCommand } = await import("./bench-corpus.js");
    return runCorpusCommand(options, io);
  }
  if (options.meter) {
    const { runMeterCommand } = await import("./bench-meter.js");
    return runMeterCommand(options, io);
  }
  if (options.compare?.length) {
    const { runCompareCommand } = await import("./bench-compare.js");
    return runCompareCommand(options, io);
  }
  if (options.models?.length || options.scripted) {
    const { runModelEvalCommand } = await import("./bench-models.js");
    return runModelEvalCommand(options, io);
  }
  if (options.measures) {
    const { runMeasuresCommand } = await import("./bench-measures.js");
    return runMeasuresCommand(options, io);
  }
  const bench = await import("@optestra/core/bench");
  let report: Awaited<ReturnType<typeof bench.runBench>>;
  try {
    report = await bench.runBench({
      fixture: fixture as "shop" | "android" | "all",
      reruns,
      ...(options.variant?.length ? { variants: options.variant } : {}),
      equivalence: options.equivalence ?? true,
      command: [
        `bench --fixture ${fixture} --reruns ${reruns}`,
        ...(options.variant ?? []).map((v) => `--variant ${v}`),
        ...(options.equivalence === false ? ["--no-equivalence"] : []),
      ].join(" "),
      onProgress: options.json ? () => {} : (line) => io.stdout(`${line}\n`),
    });
  } catch (error) {
    if (error instanceof bench.BenchSetupError) {
      io.stdout(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const dir = await bench.benchDir();
  const file = baselinePath(dir);
  const baseline = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as typeof report)
    : null;
  const comparison = baseline ? bench.compareToBaseline(report, baseline) : null;
  if (options.saveBaseline) {
    // Per fixture: a fixture that ran replaces its baseline entry (numbers and
    // how they were measured, not every row); the others stay as they were.
    const fixtures = { ...(baseline?.fixtures ?? {}) } as typeof report.fixtures;
    for (const [id, f] of Object.entries(report.fixtures))
      if (f?.status === "ran")
        fixtures[id as keyof typeof fixtures] = { ...f, rows: undefined } as never;
    const merged = bench.buildReport(report.measured, fixtures);
    writeFileSync(
      file,
      `${JSON.stringify({ ...merged, ...(baseline?.decisions ? { decisions: baseline.decisions } : {}) }, null, 2)}\n`,
    );
  }
  if (options.json) io.stdout(`${JSON.stringify({ report, baseline: comparison }, null, 2)}\n`);
  else {
    io.stdout(`\n${bench.formatBench(report, comparison)}\n`);
    if (options.saveBaseline) io.stdout(`\nSaved as the baseline: ${file}\n`);
  }
  const worse = comparison?.deltas.some((d) => d.worse && GATED.has(d.metric)) ?? false;
  const unsafe = comparison?.falsePassRose ?? report.total.falsePass.count > 0;
  return worse || unsafe ? 1 : 0;
}
