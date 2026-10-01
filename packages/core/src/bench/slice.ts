import { cpus, platform, release } from "node:os";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { brand } from "@optestra/brand";
import { runLayout, type TestResult } from "@optestra/contract";
import { BudgetMeter } from "@optestra/models";
import { version } from "../index.js";
import type { RunTestsResult } from "../run/runner.js";
import { androidRunner, type FixtureRunner, shopRunner, totals } from "./comparison.js";
import { loadCorpus, selectEntries, styleProject } from "./corpus.js";
import {
  type CostMeasurement,
  type CostPhase,
  type EvidenceMode,
  MEASUREMENT_KIND,
  MEASUREMENT_VERSION,
  type MeasuredTest,
} from "./cost.js";
import { androidFixture, mailpitRunning, projectCopy, shopFixture } from "./fixtures.js";
import { type ModelEntry, modelsFor, withoutRecordings } from "./models.js";
import { engineCommit } from "./run.js";

// COST-0: one bench slice, as one Cloud Run Job task runs it (and its local
// stand-in, and MOB-3's Android VM). It runs the slice, measures it the way the
// cost meter needs (wall, CPU, peak memory, start-up, evidence bytes, AI) and
// writes one cost measurement. Evidence goes under `out`, which is the GCS
// bucket mounted into the job in the cloud and a plain folder locally.

export interface Slice {
  fixture: "shop" | "android";
  phase: CostPhase;
  /** Variants to run (default: correct for author, every variant for replay, cosmetic for heal). */
  variants?: string[];
  evidence?: EvidenceMode;
  /** Runs of each variant (replay). */
  reruns?: number;
  /** For author: a corpus style instead of the gold tests. */
  style?: string;
  /** Only these gold tests. */
  tests?: string[];
  /** Record video (default true, as the product does). */
  video?: boolean;
}

export interface SliceOptions {
  slice: Slice;
  costRun: string;
  /** Where evidence and results go: `<out>/cost-runs/<costRun>/…`. */
  out: string;
  /** Tests in parallel inside the task (runTests workers). */
  parallel: number;
  /** What the task was given (billing is on allocation). */
  shape: { vcpu: number; memoryGiB: number };
  task: { index: number; count: number; execution: string | null; region: string | null };
  where: CostMeasurement["where"];
  /** The model for author and heal (planner and fixer); null: no AI (replay). */
  model: ModelEntry | null;
  scripted?: boolean;
  /** A folder with recordings authored elsewhere (option b: authored on a Mac, replayed in the cloud). */
  recordings?: string | null;
  /** Milliseconds from process start to the entry script's first line. */
  processStartMs: number;
  startedAt: string;
  env?: NodeJS.ProcessEnv;
  budgetUsd?: number;
  onProgress?: (line: string) => void;
}

// ── the machine: cgroup v2 in a container, the whole machine otherwise ──────────

const CGROUP = "/sys/fs/cgroup";

function readNumber(path: string, key?: string): number | null {
  try {
    const text = readFileSync(path, "utf8");
    if (!key) return Number(text.trim());
    const line = text.split("\n").find((l) => l.startsWith(`${key} `));
    return line ? Number(line.split(" ")[1]) : null;
  } catch {
    return null;
  }
}

const machineCpuSeconds = () =>
  cpus().reduce((n, c) => n + c.times.user + c.times.sys + c.times.nice + c.times.irq, 0) / 1000;

/** CPU seconds used so far by the container (cgroup), else by the whole machine. */
export function cpuNow(): { seconds: number; source: "cgroup" | "machine" } {
  const usec = readNumber(join(CGROUP, "cpu.stat"), "usage_usec");
  return usec !== null && Number.isFinite(usec)
    ? { seconds: usec / 1e6, source: "cgroup" }
    : { seconds: machineCpuSeconds(), source: "machine" };
}

/** Peak memory of the container (cgroup), else of this Node process. */
export function peakMemory(): { bytes: number; source: "cgroup" | "process" } {
  const peak = readNumber(join(CGROUP, "memory.peak"));
  return peak !== null && Number.isFinite(peak)
    ? { bytes: peak, source: "cgroup" }
    : { bytes: process.resourceUsage().maxRSS * 1024, source: "process" };
}

function folderSize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name !== "result.json") {
        bytes += statSync(path).size;
        files++;
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

function measured(
  run: RunTestsResult,
  fixture: "shop" | "android",
  variant: string,
  model: string,
): MeasuredTest[] {
  return run.tests.map((t: TestResult) => {
    const size = folderSize(join(run.dir, runLayout.testDir(t.testId)));
    const calls = t.attempts.flatMap((a) => a.modelCalls);
    const total = totals(calls, model);
    return {
      fixture,
      variant,
      test: t.file.replace(/^tests\//, "").replace(/\.test\.md$/, ""),
      verdict: t.verdict,
      durationMs: t.durationMs,
      aiCalls: calls.length,
      tokens: total.tokens,
      listUsd: total.listUsd ?? 0,
      evidenceBytes: size.bytes,
      evidenceFiles: size.files,
    };
  });
}

/** Default variants per phase. */
function variantsFor(slice: Slice, runner: FixtureRunner): string[] {
  if (slice.variants?.length) return slice.variants;
  if (slice.phase === "author") return ["correct"];
  if (slice.phase === "heal") return ["cosmetic"];
  return [...runner.variants];
}

/** Runs one slice and writes its measurement; returns it. */
export async function runSlice(options: SliceOptions): Promise<CostMeasurement> {
  const say = options.onProgress ?? (() => {});
  const { slice } = options;
  const setupStarted = Date.now();
  const cpu0 = cpuNow();
  const shop = await shopFixture();
  let runner: FixtureRunner;
  let fixtureDir: string;
  if (slice.fixture === "shop") {
    runner = await shopRunner(shop, await mailpitRunning());
    fixtureDir = shop.dir;
  } else {
    const check = await androidFixture(options.env ?? process.env);
    if (!check.ok) throw new Error(`Android: ${check.reason}`);
    runner = await androidRunner(check.fixture, shop);
    fixtureDir = check.fixture.dir;
  }

  // The project the slice runs in, one per lane: `parallel` lanes split the
  // tests round-robin, each with its own project copy and its own fixture server
  // (the shop's state lives in the server), so parallel tests never share state.
  const makeProject = (only: readonly string[] | null): string => {
    let dir: string;
    if (slice.style) {
      const entries = selectEntries(loadCorpus(shop.benchDir), {
        fixtures: [slice.fixture],
        styles: [slice.style],
        ...(slice.tests?.length ? { tests: slice.tests } : {}),
      }).filter((e) => !only || only.includes(e.gold));
      dir = styleProject(fixtureDir, entries, slice.phase !== "author");
    } else {
      dir = projectCopy(fixtureDir, "slice-");
      const keep = only ?? slice.tests ?? null;
      if (keep) {
        const names = new Set(keep.map((t) => `${t}.test.md`));
        for (const f of readdirSync(join(dir, "tests")))
          if (f.endsWith(".test.md") && !names.has(f)) rmSync(join(dir, "tests", f));
      }
      if (slice.phase === "author") withoutRecordings(dir);
    }
    // Option b: recordings authored elsewhere replace the committed ones.
    if (options.recordings && slice.phase !== "author") {
      const data = join(dir, "tests", brand.dataDirName);
      for (const f of readdirSync(options.recordings))
        if (f.endsWith(".steps.json")) cpSync(join(options.recordings, f), join(data, f));
    }
    return dir;
  };
  const all = readdirSync(join(fixtureDir, "tests"))
    .filter((f) => f.endsWith(".test.md"))
    .map((f) => f.replace(/\.test\.md$/, ""))
    .filter((t) => !slice.tests?.length || slice.tests.includes(t));
  // One emulator: Android runs one lane.
  const lanes =
    slice.fixture === "android" ? 1 : Math.max(1, Math.min(options.parallel, all.length));
  const dirs = Array.from({ length: lanes }, (_, i) =>
    makeProject(lanes === 1 ? null : all.filter((_, n) => n % lanes === i)),
  );
  const setupMs = Date.now() - setupStarted;

  const model = options.model?.model ?? "none";
  const budget = new BudgetMeter("run", options.budgetUsd ?? 10, "cost run budget");
  const evidence = slice.evidence ?? "failures";
  const tests: MeasuredTest[] = [];
  const runsOut = join(
    options.out,
    "cost-runs",
    options.costRun,
    "evidence",
    `task-${options.task.index}`,
  );
  const runDirs: string[] = [];
  const testsStarted = Date.now();
  const lane = async (dir: string, n: number) => {
    for (const variant of variantsFor(slice, runner)) {
      const reruns = slice.phase === "replay" ? Math.max(1, slice.reruns ?? 1) : 1;
      for (let r = 1; r <= reruns; r++) {
        const ai = slice.phase !== "replay" && options.model !== null;
        const { run, ms } = await runner.run(variant, dir, {
          evidence,
          video: slice.video ?? true,
          ...(slice.phase === "author" ? { mode: "normal", retries: 0 } : {}),
          ...(slice.phase === "heal" ? { mode: "normal" } : {}),
          ...(ai && options.model
            ? {
                models: await modelsFor(
                  dir,
                  options.model,
                  {
                    scripted: options.scripted ?? false,
                    ...(options.env ? { env: options.env } : {}),
                  },
                  budget,
                ),
              }
            : {}),
        });
        tests.push(...measured(run, slice.fixture, variant, model));
        runDirs.push(run.dir);
        say(
          `${slice.fixture} ${slice.phase} ${variant} #${r}${lanes > 1 ? ` (lane ${n + 1}/${lanes})` : ""}: ${run.tests.length} tests in ${(ms / 1000).toFixed(1)} s`,
        );
      }
    }
  };
  try {
    await Promise.all(dirs.map((d, n) => lane(d, n)));
  } finally {
    await runner.close();
  }
  const testsWallMs = Date.now() - testsStarted;

  // Evidence and the measurement go to `out` (the bucket in the cloud).
  const teardownStarted = Date.now();
  mkdirSync(runsOut, { recursive: true });
  for (const runDir of runDirs)
    if (existsSync(runDir))
      cpSync(runDir, join(runsOut, runDir.split(/[\\/]/).at(-1) ?? "run"), { recursive: true });
  // Option b: what authoring recorded goes next to the results, for replay elsewhere.
  if (slice.phase === "author") {
    const saved = join(options.out, "cost-runs", options.costRun, "recordings");
    mkdirSync(saved, { recursive: true });
    for (const d of dirs) {
      const data = join(d, "tests", brand.dataDirName);
      if (!existsSync(data)) continue;
      for (const f of readdirSync(data))
        if (f.endsWith(".steps.json")) cpSync(join(data, f), join(saved, f));
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  const teardownMs = Date.now() - teardownStarted;

  const cpu1 = cpuNow();
  const memory = peakMemory();
  const measurement: CostMeasurement = {
    kind: MEASUREMENT_KIND,
    version: MEASUREMENT_VERSION,
    costRun: options.costRun,
    where: options.where,
    task: options.task,
    shape: { ...options.shape, parallel: lanes },
    slice: {
      fixture: slice.fixture,
      phase: slice.phase,
      variants: variantsFor(slice, runner),
      evidence,
      reruns: slice.reruns ?? 1,
      style: slice.style ?? null,
    },
    timing: {
      startedAt: options.startedAt,
      containerStartMs: null,
      processStartMs: Math.round(options.processStartMs),
      setupMs,
      teardownMs,
      taskWallMs: Date.now() - Date.parse(options.startedAt),
      testsWallMs,
    },
    resources: {
      cpuSeconds: Math.round((cpu1.seconds - cpu0.seconds) * 10) / 10,
      cpuSource: cpu1.source,
      peakMemoryBytes: memory.bytes,
      memorySource: memory.source,
    },
    tests,
    model: options.model ? `${options.model.provider}:${options.model.model}` : null,
    vm: null,
    env: {
      node: process.version,
      engineVersion: version(),
      commit: engineCommit(shop.benchDir),
      os: `${platform()} ${release()} (${cpus()[0]?.model ?? "cpu"}, ${cpus().length} cores)`,
    },
  };
  const results = join(options.out, "cost-runs", options.costRun, "results");
  mkdirSync(results, { recursive: true });
  writeFileSync(
    join(
      results,
      `${slice.fixture}-${slice.phase}-task-${options.task.index}${options.task.execution ? `-${options.task.execution}` : ""}.json`,
    ),
    `${JSON.stringify(measurement, null, 2)}\n`,
  );
  return measurement;
}
