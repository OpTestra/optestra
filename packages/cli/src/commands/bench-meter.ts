import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BenchCommandOptions } from "./bench.js";
import type { CommandIo } from "./config.js";

// `bench --meter <path>` (COST-0): the cost meter. <path> is a cost run's folder
// (cost-runs/<id>/, with results/*.json from every task and the cloud.json that
// run.sh writes) or one measurement file. Applies bench/cloud/prices.yaml and
// writes <date>-cloud-baseline.json and .md (to bench/results, or --out).

function measurementFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  const results = existsSync(join(path, "results")) ? join(path, "results") : path;
  return readdirSync(results)
    .filter((f) => f.endsWith(".json") && f !== "cloud.json")
    .map((f) => join(results, f));
}

export async function runMeterCommand(
  options: BenchCommandOptions,
  io: CommandIo,
): Promise<number> {
  const bench = await import("@optestra/core/bench");
  const path = resolve(io.cwd, options.meter as string);
  if (!existsSync(path)) {
    io.stdout(`${options.meter}: no such file or folder.\n`);
    return 2;
  }
  const measurements = measurementFiles(path)
    .map((f) => JSON.parse(readFileSync(f, "utf8")) as { kind?: string })
    .filter((m) => m.kind === bench.MEASUREMENT_KIND) as unknown as Parameters<
    typeof bench.meterReport
  >[0];
  if (measurements.length === 0) {
    io.stdout(`No cost measurements in ${options.meter} (results/*.json from the run's tasks).\n`);
    return 2;
  }
  const dir = await bench.benchDir();
  const factsFile = statSync(path).isDirectory() ? join(path, "cloud.json") : null;
  const facts =
    factsFile && existsSync(factsFile)
      ? (JSON.parse(readFileSync(factsFile, "utf8")) as Parameters<
          typeof bench.withCloudFacts
        >[1] & { secretVersions?: number })
      : {};
  const first = measurements[0] as (typeof measurements)[number];
  const prices = bench.loadCloudPrices(join(dir, "cloud", "prices.yaml"));
  const date = new Date().toISOString();
  const report = bench.meterReport(bench.withCloudFacts(measurements, facts), prices, {
    costRun: first.costRun,
    date,
    command: `bench --meter ${options.meter}`,
    engineVersion: first.env.engineVersion,
    commit: first.env.commit,
    buildMinutes: facts.buildMinutes ?? null,
    imageGiB: facts.imageGiB ?? null,
    ...(facts.secretVersions !== undefined ? { secretVersions: facts.secretVersions } : {}),
  });
  const outDir = options.out ? resolve(io.cwd, options.out) : join(dir, "results");
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `${date.slice(0, 10)}-cloud-baseline`);

  // The full baseline when the run has more than cloud tasks: the corpus results
  // (--corpus-results) and MOB-3's Android vm-run.json files under the run folder.
  const corpus = (options.corpusResults ?? []).map(
    (f) =>
      JSON.parse(readFileSync(resolve(io.cwd, f), "utf8")) as Parameters<
        typeof bench.assembleBaseline
      >[0]["corpus"][number],
  );
  const vmRuns = statSync(path).isDirectory() ? vmRunFiles(path) : [];
  if (corpus.length === 0 && vmRuns.length === 0) {
    writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(`${base}.md`, bench.formatBaseline(report));
    io.stdout(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${bench.formatBaseline(report)}\nWrote ${base}.json and ${base}.md\n`,
    );
    return 0;
  }
  const raw = (
    bench.loadRawPrices as (file: string) => {
      aiOffPeak?: Record<string, { factor: number; window: string }>;
    }
  )(join(dir, "cloud", "prices.yaml"));
  const model = corpus[0]?.model ?? report.ai.model ?? "";
  const offPeak = raw.aiOffPeak?.[model] ?? null;
  const extra = facts as {
    idle?: Parameters<typeof bench.assembleBaseline>[0]["idle"];
    ollamaUsageUsd?: number;
  };
  const baseline = bench.assembleBaseline({
    cloud: report,
    corpus,
    vmRuns: vmRuns.map((f) => JSON.parse(readFileSync(f, "utf8"))),
    measurements,
    prices,
    complexity: complexityMap(join(dir, "results")),
    ai: { offPeakFactor: offPeak?.factor ?? null, offPeakWindow: offPeak?.window ?? null },
    idle: extra.idle ?? { staging: null, reaper: null, registryGiB: 0, images: [] },
    ollamaUsageUsd: extra.ollamaUsageUsd ?? null,
  });
  const md = `${bench.formatCostBaseline(baseline)}${bench
    .formatBaseline(report)
    .split("\n")
    .slice(2)
    .join("\n")}`;
  writeFileSync(`${base}.json`, `${JSON.stringify(baseline, null, 2)}\n`);
  writeFileSync(`${base}.md`, md);
  io.stdout(
    options.json
      ? `${JSON.stringify(baseline, null, 2)}\n`
      : `${md}\nWrote ${base}.json and ${base}.md\n`,
  );
  return 0;
}

/** MOB-3's run files under the run folder: android-*\/vm-run*.json (the replay and corpus runs). */
function vmRunFiles(path: string): string[] {
  const out: string[] = [];
  for (const d of readdirSync(path, { withFileTypes: true }))
    if (d.isDirectory() && d.name.startsWith("android"))
      for (const f of readdirSync(join(path, d.name)))
        if (/^vm-run-.+\.json$/.test(f)) out.push(join(path, d.name, f));
  return out.sort();
}

/** Each gold test's complexity, from the newest model comparison that classified it. */
function complexityMap(results: string): Record<string, "simple" | "medium" | "complex"> {
  const map: Record<string, "simple" | "medium" | "complex"> = {};
  const files = readdirSync(results)
    .filter((f) => f.endsWith("-model-comparison.json") || f.endsWith("-open-models.json"))
    .sort()
    .reverse();
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(results, file), "utf8")) as {
        models: Array<{
          fixtures: Array<{
            authoring: {
              perTest: Array<{ test: string; complexity: "simple" | "medium" | "complex" }>;
            };
          }>;
        }>;
      };
      for (const t of parsed.models[0]?.fixtures.flatMap((f) => f.authoring.perTest) ?? []) {
        const gold = t.test.replace(/^tests\//, "").replace(/\.test\.md$/, "");
        map[gold] ??= t.complexity;
      }
    } catch {
      // Unreadable: skipped.
    }
  }
  return map;
}
