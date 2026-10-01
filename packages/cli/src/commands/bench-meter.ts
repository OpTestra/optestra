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
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${base}.md`, bench.formatBaseline(report));
  io.stdout(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${bench.formatBaseline(report)}\nWrote ${base}.json and ${base}.md\n`,
  );
  return 0;
}
