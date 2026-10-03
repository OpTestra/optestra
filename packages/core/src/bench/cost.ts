import { readFileSync } from "node:fs";
import { parseYaml } from "@optestra/config/node";

// COST-0: the cost meter. Each cloud task (or its local stand-in, or the Android
// VM) writes one measurement: what it ran, for how long, on which shape, with
// how much CPU, memory, evidence and AI. The meter applies the list prices in
// bench/cloud/prices.yaml and reports $ per test (author / replay / heal), per
// Android test, per run of N tests, the fixed per-run overhead and the idle
// monthly cost. Pure: no network, no clock; unit-tested on a committed run.

export const MEASUREMENT_KIND = "cost-measurement";
export const MEASUREMENT_VERSION = 1;
export const BASELINE_VERSION = 1;

export type CostPhase = "author" | "replay" | "heal";
export type EvidenceMode = "full" | "failures" | "minimal";

export interface MeasuredTest {
  fixture: "shop" | "android";
  variant: string;
  test: string;
  verdict: string;
  durationMs: number;
  aiCalls: number;
  tokens: { input: number; output: number; cached: number; cacheWrite: number };
  /** List $ of its AI calls (prices.yaml of the models package). */
  listUsd: number;
  /** Bytes the run folder keeps for this test (screenshots, trace, video, logs). */
  evidenceBytes: number;
  evidenceFiles: number;
}

export interface CostMeasurement {
  kind: typeof MEASUREMENT_KIND;
  version: typeof MEASUREMENT_VERSION;
  costRun: string;
  /** cloud-run: a Cloud Run Job task; local: the same entry on this machine; android-vm: MOB-3's VM. */
  where: "cloud-run" | "local" | "android-vm";
  task: { index: number; count: number; execution: string | null; region: string | null };
  /** What was allocated (billing is on allocation, not use). */
  shape: { vcpu: number; memoryGiB: number; parallel: number; machine?: string | null };
  slice: {
    fixture: "shop" | "android";
    phase: CostPhase;
    variants: string[];
    evidence: EvidenceMode;
    reruns: number;
    style?: string | null;
  };
  timing: {
    /** Wall clock when the entry script started (ISO). */
    startedAt: string;
    /** Container (or VM) start: from the task's creation to the entry script's first line, when known. */
    containerStartMs: number | null;
    /** Node start to the entry script's first line. */
    processStartMs: number;
    /** Browser launch / emulator boot, fixture server start, before the first test. */
    setupMs: number;
    /** Uploading evidence and results after the last test. */
    teardownMs: number;
    /** The whole task, process start to exit. */
    taskWallMs: number;
    /** Only the test runs. */
    testsWallMs: number;
  };
  resources: {
    cpuSeconds: number;
    /** cgroup = the whole container (browser included); machine = every core of this machine; process = Node only. */
    cpuSource: "cgroup" | "machine" | "process";
    peakMemoryBytes: number;
    memorySource: "cgroup" | "process";
  };
  tests: MeasuredTest[];
  /** Evidence that couldn't be copied to `out` (the measurement itself is still written). */
  uploadProblems?: string[];
  model: string | null;
  /** Android VM: the machine's own times (MOB-3's phases.json), when known. */
  vm?: {
    createMs: number | null;
    sshReadyMs: number | null;
    setupMs: number | null;
    diskGiB: number;
    hourlyUsd: number | null;
  } | null;
  env: { node: string; engineVersion: string; commit: string | null; os: string };
}

export interface CloudPrices {
  checked: string;
  currency: string;
  region: string;
  hoursPerMonth: number;
  cloudRun: {
    jobs: {
      vcpuSecond: number;
      gibSecond: number;
      roundingSeconds: number;
      minimumSecondsPerTask: number;
      requests: number;
    };
    freeTier: { vcpuSeconds: number; gibSeconds: number };
  };
  storage: {
    standardGibMonth: number;
    classAPer1000: number;
    classBPer1000: number;
    egressInternetGib: number;
    egressSameRegionGib: number;
  };
  cloudBuild: { e2Standard2Minute: number; freeMinutesPerMonth: number };
  artifactRegistry: { gibMonth: number; freeGibMonth: number };
  secretManager: {
    versionMonth: number;
    freeVersions: number;
    accessPer10000: number;
    freeAccesses: number;
  };
  compute: {
    spot: Record<string, { hour: number; vcpu: number; memoryGiB: number }>;
    pdBalancedGibMonth: number;
  };
  neon: number;
  workos: number;
}

export function loadCloudPrices(path: string): CloudPrices {
  const value = parseYaml(readFileSync(path, "utf8"), "prices.yaml").value as Omit<
    CloudPrices,
    "checked"
  > & {
    checked: unknown;
  };
  const checked =
    value.checked instanceof Date
      ? value.checked.toISOString().slice(0, 10)
      : String(value.checked);
  return { ...value, checked };
}

/** The price file as written, for sections the typed loader doesn't model (aiOffPeak). */
export function loadRawPrices(path: string): Record<string, unknown> {
  return parseYaml(readFileSync(path, "utf8"), "prices.yaml").value as Record<string, unknown>;
}

/** Facts about the run that aren't in any task: the image build, its size, retention, secrets. */
export interface MeterContext {
  costRun: string;
  date: string;
  command: string;
  engineVersion: string;
  commit: string | null;
  /** Minutes the Cloud Build took (null when nothing was built). */
  buildMinutes: number | null;
  /** The image in Artifact Registry, GiB (null when unknown). */
  imageGiB: number | null;
  /** How long evidence is kept, in days, for the per-test storage price (default 30, the product's). */
  retentionDays?: number;
  /** Secret Manager versions the setup keeps (the API key, option a). */
  secretVersions?: number;
  /** Results and evidence objects someone downloads once (egress). Default: none. */
  downloadedOnce?: boolean;
}

const GIB = 1024 ** 3;
const round = (n: number, digits = 8) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Seconds Cloud Run bills for a task of this wall time. */
export function billableSeconds(wallMs: number, jobs: CloudPrices["cloudRun"]["jobs"]): number {
  const seconds = Math.max(jobs.minimumSecondsPerTask, wallMs / 1000);
  return Math.ceil(round(seconds / jobs.roundingSeconds, 6)) * jobs.roundingSeconds;
}

/** $ per second of one task of this shape. */
export function shapeRate(
  shape: CostMeasurement["shape"],
  jobs: CloudPrices["cloudRun"]["jobs"],
): number {
  return shape.vcpu * jobs.vcpuSecond + shape.memoryGiB * jobs.gibSecond;
}

export interface PhaseCost {
  phase: CostPhase;
  fixture: "shop" | "android";
  evidence: EvidenceMode;
  /** The variants the tests ran on, e.g. "correct" or "correct+broken-total" (failing tests retry and keep more). */
  variants: string;
  tests: number;
  /** Seconds of task time one more test adds (its run time over the tests in parallel). */
  marginalSecondsPerTest: number;
  compute: number;
  storage: number;
  operations: number;
  ai: number;
  total: number;
  aiCalls: number;
}

export interface ShapeCost {
  shape: string;
  vcpu: number;
  memoryGiB: number;
  parallel: number;
  tasks: number;
  ratePerSecond: number;
  /** Task time that isn't tests: container start, Node start, browser launch, upload. */
  overheadSeconds: number;
  /** $ of the overhead, with the 1-minute minimum applied to an empty task. */
  fixedPerRun: number;
  phases: PhaseCost[];
  perRun: Array<{ tests: number; phase: CostPhase; seconds: number; usd: number }>;
  /** Replays of the unchanged app (correct) on this shape: did every one pass? */
  verdicts: { correctRuns: number; passed: number; ok: boolean };
  /** Seconds a run of 20 replays takes on this shape (CI-6: at most 600). */
  twentyTestsSeconds: number | null;
  /** Same verdicts and 20 tests within CI-6's 10 minutes. */
  good: boolean;
}

/** CI-6: a PR check of 20 tests finishes within 10 minutes. */
export const CI6_SECONDS_FOR_20 = 600;

export interface CloudBaseline {
  baselineVersion: typeof BASELINE_VERSION;
  kind: "cloud-baseline";
  costRun: string;
  date: string;
  engineVersion: string;
  commit: string | null;
  command: string;
  /** How it was measured, in words (same header idea as EVAL-0). */
  measured: string[];
  prices: { file: string; checked: string; region: string };
  where: string[];
  measurements: {
    tasks: number;
    tests: number;
    wallSeconds: number;
    cpuSeconds: number;
    cpuSources: string[];
    peakMemoryMiB: number;
    containerStartMs: { median: number | null; max: number | null };
    processStartMs: number;
    setupMs: number;
    evidence: Array<{
      fixture: string;
      mode: EvidenceMode;
      passingMiB: number;
      failingMiB: number;
      filesPerTest: number;
    }>;
  };
  shapes: ShapeCost[];
  /** The cheapest shape's numbers, per web test. */
  perWebTest: Record<CostPhase, number | null>;
  perAndroidTest: {
    replay: number | null;
    author: number | null;
    vmHour: number | null;
    fixedPerVm: number | null;
  };
  fixedPerRunOverhead: number | null;
  ai: { calls: number; listUsd: number; model: string | null };
  oneOff: { build: number | null; buildMinutes: number | null };
  idleMonthly: { total: number; items: Array<{ item: string; usd: number; note: string }> };
  freeTier: string;
  totals: {
    compute: number;
    storage: number;
    ai: number;
    build: number;
    androidVm: number;
    all: number;
  };
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] ?? null;
};

const shapeKey = (s: CostMeasurement["shape"]) =>
  `${s.vcpu} vCPU / ${s.memoryGiB} GiB × ${s.parallel}`;

/** $ to keep `bytes` for `days`, plus one Class A write per file. */
function storageCost(
  bytes: number,
  files: number,
  days: number,
  prices: CloudPrices,
): { storage: number; operations: number } {
  return {
    storage: (bytes / GIB) * prices.storage.standardGibMonth * (days / (prices.hoursPerMonth / 24)),
    operations: (files / 1000) * prices.storage.classAPer1000,
  };
}

/** Per phase, the product's default evidence mode (failures) when measured, else what was. */
function headline(phases: readonly PhaseCost[]): PhaseCost[] {
  const out: PhaseCost[] = [];
  for (const phase of ["author", "replay", "heal"] as const)
    for (const fixture of ["shop", "android"] as const) {
      const list = phases.filter((p) => p.phase === phase && p.fixture === fixture);
      const failures = list.filter((p) => p.evidence === "failures");
      // Replay's headline is the unchanged app (correct); a heal is on cosmetic.
      const pick = failures.find((p) => p.variants === "correct") ?? failures[0] ?? list[0];
      if (pick) out.push(pick);
    }
  return out;
}

function cloudShapes(
  measurements: readonly CostMeasurement[],
  prices: CloudPrices,
  days: number,
): ShapeCost[] {
  const jobs = prices.cloudRun.jobs;
  const byShape = new Map<string, CostMeasurement[]>();
  for (const m of measurements.filter((x) => x.where !== "android-vm")) {
    const key = shapeKey(m.shape);
    byShape.set(key, [...(byShape.get(key) ?? []), m]);
  }
  const out: ShapeCost[] = [];
  for (const [key, list] of byShape) {
    const shape = list[0]?.shape as CostMeasurement["shape"];
    const rate = shapeRate(shape, jobs);
    // Overhead: the task's time that isn't tests, median over tasks.
    const overheads = list.map((m) => {
      const start = (m.timing.containerStartMs ?? 0) + m.timing.processStartMs;
      return Math.max(0, (start + m.timing.taskWallMs - m.timing.testsWallMs) / 1000);
    });
    const overheadSeconds = round(median(overheads) ?? 0, 3);
    const phases: PhaseCost[] = [];
    const workloads = [...new Set(list.map((m) => m.slice.variants.join("+")))];
    for (const phase of ["author", "replay", "heal"] as const)
      for (const fixture of ["shop", "android"] as const)
        for (const evidence of ["failures", "full", "minimal"] as const)
          for (const variants of workloads) {
            const tasks = list.filter(
              (m) =>
                m.slice.phase === phase &&
                m.slice.fixture === fixture &&
                m.slice.evidence === evidence &&
                m.slice.variants.join("+") === variants,
            );
            const tests = tasks.flatMap((m) => m.tests);
            if (tests.length === 0) continue;
            // Wall seconds the tests occupied, over the tests run (parallel tests share the task).
            const testSeconds = tasks.reduce((n, m) => n + m.timing.testsWallMs / 1000, 0);
            const marginal = testSeconds / tests.length;
            const bytes = tests.reduce((n, t) => n + t.evidenceBytes, 0) / tests.length;
            const files = tests.reduce((n, t) => n + t.evidenceFiles, 0) / tests.length;
            const kept = storageCost(bytes, files, days, prices);
            const ai = tests.reduce((n, t) => n + t.listUsd, 0) / tests.length;
            const compute = marginal * rate;
            phases.push({
              phase,
              fixture,
              evidence,
              variants,
              tests: tests.length,
              marginalSecondsPerTest: round(marginal, 3),
              compute: round(compute),
              storage: round(kept.storage),
              operations: round(kept.operations),
              ai: round(ai),
              total: round(compute + kept.storage + kept.operations + ai),
              aiCalls: tests.reduce((n, t) => n + t.aiCalls, 0),
            });
          }
    const perRun: ShapeCost["perRun"] = [];
    for (const p of headline(phases.filter((x) => x.fixture === "shop")))
      for (const n of [1, 10, 20, 50, 100]) {
        const seconds = billableSeconds(
          (overheadSeconds + n * p.marginalSecondsPerTest) * 1000,
          jobs,
        );
        perRun.push({
          tests: n,
          phase: p.phase,
          seconds: round(seconds, 1),
          usd: round(seconds * rate + n * (p.storage + p.operations + p.ai)),
        });
      }
    const correct = list
      .filter((m) => m.slice.phase === "replay" && m.slice.variants.join("+") === "correct")
      .flatMap((m) => m.tests);
    const replayCorrect = phases.find(
      (p) => p.phase === "replay" && p.fixture === "shop" && p.variants === "correct",
    );
    const twentyTestsSeconds = replayCorrect
      ? round(overheadSeconds + 20 * replayCorrect.marginalSecondsPerTest, 1)
      : null;
    const verdicts = {
      correctRuns: correct.length,
      passed: correct.filter((t) => t.verdict === "passed").length,
      ok: correct.length > 0 && correct.every((t) => t.verdict === "passed"),
    };
    out.push({
      shape: key,
      verdicts,
      twentyTestsSeconds,
      good: verdicts.ok && twentyTestsSeconds !== null && twentyTestsSeconds <= CI6_SECONDS_FOR_20,
      vcpu: shape.vcpu,
      memoryGiB: shape.memoryGiB,
      parallel: shape.parallel,
      tasks: list.length,
      ratePerSecond: round(rate, 10),
      overheadSeconds,
      fixedPerRun: round(billableSeconds(overheadSeconds * 1000, jobs) * rate),
      phases,
      perRun,
    });
  }
  return out.sort((a, b) => a.shape.localeCompare(b.shape));
}

function androidCost(
  measurements: readonly CostMeasurement[],
  prices: CloudPrices,
  days: number,
): CloudBaseline["perAndroidTest"] & { vmTotal: number } {
  const vms = measurements.filter((m) => m.where === "android-vm");
  if (vms.length === 0)
    return { replay: null, author: null, vmHour: null, fixedPerVm: null, vmTotal: 0 };
  const hourOf = (m: CostMeasurement) =>
    m.vm?.hourlyUsd ?? prices.compute.spot[m.shape.machine ?? "n2-standard-4"]?.hour ?? null;
  const disk = (m: CostMeasurement) =>
    ((m.vm?.diskGiB ?? 30) * prices.compute.pdBalancedGibMonth) / prices.hoursPerMonth;
  const perHour = (m: CostMeasurement) => (hourOf(m) ?? 0) + disk(m);
  const forPhase = (phase: CostPhase) => {
    const list = vms.filter((m) => m.slice.phase === phase);
    const tests = list.flatMap((m) => m.tests);
    if (tests.length === 0) return null;
    const compute = list.reduce((n, m) => n + (m.timing.testsWallMs / 3_600_000) * perHour(m), 0);
    const bytes = tests.reduce((n, t) => n + t.evidenceBytes, 0) / tests.length;
    const files = tests.reduce((n, t) => n + t.evidenceFiles, 0) / tests.length;
    const kept = storageCost(bytes, files, days, prices);
    const ai = tests.reduce((n, t) => n + t.listUsd, 0) / tests.length;
    return round(compute / tests.length + kept.storage + kept.operations + ai);
  };
  const first = vms[0] as CostMeasurement;
  const fixedMs =
    (first.vm?.createMs ?? 0) +
    (first.vm?.sshReadyMs ?? 0) +
    (first.vm?.setupMs ?? 0) +
    first.timing.setupMs;
  const vmTotal = vms.reduce(
    (n, m) =>
      n +
      ((m.timing.taskWallMs +
        (m.vm?.createMs ?? 0) +
        (m.vm?.sshReadyMs ?? 0) +
        (m.vm?.setupMs ?? 0)) /
        3_600_000) *
        perHour(m),
    0,
  );
  return {
    replay: forPhase("replay"),
    author: forPhase("author"),
    vmHour: round(perHour(first), 6),
    fixedPerVm: round((fixedMs / 3_600_000) * perHour(first)),
    vmTotal: round(vmTotal),
  };
}

function evidenceTable(
  measurements: readonly CostMeasurement[],
): CloudBaseline["measurements"]["evidence"] {
  const out: CloudBaseline["measurements"]["evidence"] = [];
  const mib = (b: number) => Math.round((b / 1024 ** 2) * 1000) / 1000;
  for (const fixture of ["shop", "android"] as const)
    for (const mode of ["full", "failures", "minimal"] as const) {
      const tests = measurements
        .filter((m) => m.slice.fixture === fixture && m.slice.evidence === mode)
        .flatMap((m) => m.tests);
      if (tests.length === 0) continue;
      const passing = tests.filter((t) => t.verdict === "passed" || t.verdict === "healed");
      const failing = tests.filter((t) => !(t.verdict === "passed" || t.verdict === "healed"));
      const avg = (list: MeasuredTest[]) =>
        list.length ? list.reduce((n, t) => n + t.evidenceBytes, 0) / list.length : 0;
      out.push({
        fixture,
        mode,
        passingMiB: mib(avg(passing)),
        failingMiB: mib(avg(failing)),
        filesPerTest:
          Math.round((tests.reduce((n, t) => n + t.evidenceFiles, 0) / tests.length) * 10) / 10,
      });
    }
  return out;
}

/** What `run.sh` records about each Cloud Run task and the build (from gcloud). */
export interface CloudFacts {
  buildMinutes?: number | null;
  imageGiB?: number | null;
  tasks?: Array<{
    execution: string;
    index: number;
    createTime: string | null;
    startTime: string | null;
  }>;
}

/**
 * Fills each task's container start from gcloud's task times: the task's
 * creation to the entry script's first line (scheduling, image pull, boot, Node).
 */
export function withCloudFacts(
  measurements: readonly CostMeasurement[],
  facts: CloudFacts,
): CostMeasurement[] {
  return measurements.map((m) => {
    if (m.timing.containerStartMs !== null || m.where !== "cloud-run") return m;
    const task = facts.tasks?.find(
      (t) => t.execution === m.task.execution && t.index === m.task.index,
    );
    const created = task?.createTime ? Date.parse(task.createTime) : Number.NaN;
    const entry = Date.parse(m.timing.startedAt) - m.timing.processStartMs;
    if (!Number.isFinite(created) || !Number.isFinite(entry)) return m;
    return { ...m, timing: { ...m.timing, containerStartMs: Math.max(0, entry - created) } };
  });
}

/** The cost report for one cost run. */
export function meterReport(
  measurements: readonly CostMeasurement[],
  prices: CloudPrices,
  context: MeterContext,
  pricesFile = "bench/cloud/prices.yaml",
): CloudBaseline {
  const days = context.retentionDays ?? 30;
  const jobs = prices.cloudRun.jobs;
  const shapes = cloudShapes(measurements, prices, days);
  const android = androidCost(measurements, prices, days);
  const tests = measurements.flatMap((m) => m.tests);
  const cheapest = (phase: CostPhase) => {
    const values = shapes
      .flatMap((s) => headline(s.phases).filter((p) => p.phase === phase && p.fixture === "shop"))
      .map((p) => p.total);
    return values.length ? Math.min(...values) : null;
  };
  const cloudTasks = measurements.filter((m) => m.where !== "android-vm");
  const compute = cloudTasks.reduce(
    (n, m) =>
      n +
      billableSeconds(
        (m.timing.containerStartMs ?? 0) + m.timing.processStartMs + m.timing.taskWallMs,
        jobs,
      ) *
        shapeRate(m.shape, jobs),
    0,
  );
  const storage = tests.reduce((n, t) => {
    const kept = storageCost(t.evidenceBytes, t.evidenceFiles, 7, prices);
    return n + kept.storage + kept.operations;
  }, 0);
  const ai = tests.reduce((n, t) => n + t.listUsd, 0);
  const build =
    context.buildMinutes === null
      ? null
      : round(context.buildMinutes * prices.cloudBuild.e2Standard2Minute);
  const image = context.imageGiB ?? 0;
  const versions = context.secretVersions ?? 0;
  const idle = [
    {
      item: "Artifact Registry: the runner image",
      usd: round(
        Math.max(0, image - prices.artifactRegistry.freeGibMonth) *
          prices.artifactRegistry.gibMonth,
        4,
      ),
      note: `${image.toFixed(2)} GiB, first ${prices.artifactRegistry.freeGibMonth} GiB-month free; down.sh deletes it`,
    },
    {
      item: "Secret Manager: the API key",
      usd: round(
        Math.max(0, versions - prices.secretManager.freeVersions) *
          prices.secretManager.versionMonth,
        4,
      ),
      note: `${versions} active version(s), ${prices.secretManager.freeVersions} free`,
    },
    { item: "Cloud Run Job", usd: 0, note: "a job costs nothing between executions" },
    {
      item: "Cloud Storage bucket",
      usd: 0,
      note: "evidence deleted after 7 days by the lifecycle rule; an empty bucket is free",
    },
    {
      item: "Neon, WorkOS",
      usd: prices.neon + prices.workos,
      note: "free tiers at this scale; not used by the runner",
    },
  ];
  const fixed = shapes.length ? Math.min(...shapes.map((s) => s.fixedPerRun)) : null;
  const allTotal = compute + storage + ai + (build ?? 0) + android.vmTotal;
  const cpuSources = [...new Set(measurements.map((m) => m.resources.cpuSource))];
  return {
    baselineVersion: BASELINE_VERSION,
    kind: "cloud-baseline",
    costRun: context.costRun,
    date: context.date,
    engineVersion: context.engineVersion,
    commit: context.commit,
    command: context.command,
    measured: [
      `Cost run ${context.costRun}: ${measurements.length} task(s) (${[...new Set(measurements.map((m) => m.where))].join(", ")}), ${tests.length} test runs.`,
      "Compute is billed on allocation: every task's wall time (container start included when known), rounded up to 100 ms, at least 1 minute, times its vCPU and GiB. Per-test compute is the task time one more test adds; the rest is the fixed per-run overhead.",
      `Storage per test keeps its evidence ${days} days (the product's retention; this run's bucket deletes after 7) plus one Class A write per file. AI at list API prices (packages/models/prices.yaml), also for subscription calls.`,
      `List prices before free tiers, checked ${prices.checked} (${pricesFile}).`,
    ],
    prices: { file: pricesFile, checked: prices.checked, region: prices.region },
    where: [...new Set(measurements.map((m) => m.where))],
    measurements: {
      tasks: measurements.length,
      tests: tests.length,
      wallSeconds: round(measurements.reduce((n, m) => n + m.timing.taskWallMs, 0) / 1000, 1),
      cpuSeconds: round(
        measurements.reduce((n, m) => n + m.resources.cpuSeconds, 0),
        1,
      ),
      cpuSources,
      peakMemoryMiB: Math.round(
        Math.max(0, ...measurements.map((m) => m.resources.peakMemoryBytes)) / 1024 ** 2,
      ),
      containerStartMs: {
        median: median(
          measurements.flatMap((m) =>
            m.timing.containerStartMs === null ? [] : [m.timing.containerStartMs],
          ),
        ),
        max: measurements.some((m) => m.timing.containerStartMs !== null)
          ? Math.max(
              ...measurements.flatMap((m) =>
                m.timing.containerStartMs === null ? [] : [m.timing.containerStartMs],
              ),
            )
          : null,
      },
      processStartMs: median(measurements.map((m) => m.timing.processStartMs)) ?? 0,
      setupMs: median(measurements.map((m) => m.timing.setupMs)) ?? 0,
      evidence: evidenceTable(measurements),
    },
    shapes,
    perWebTest: { author: cheapest("author"), replay: cheapest("replay"), heal: cheapest("heal") },
    perAndroidTest: {
      replay: android.replay,
      author: android.author,
      vmHour: android.vmHour,
      fixedPerVm: android.fixedPerVm,
    },
    fixedPerRunOverhead: fixed,
    ai: {
      calls: tests.reduce((n, t) => n + t.aiCalls, 0),
      listUsd: round(ai, 6),
      model: measurements.find((m) => m.model)?.model ?? null,
    },
    oneOff: { build, buildMinutes: context.buildMinutes },
    idleMonthly: {
      total: round(
        idle.reduce((n, i) => n + i.usd, 0),
        4,
      ),
      items: idle,
    },
    freeTier: `Cloud Run's free tier (${prices.cloudRun.freeTier.vcpuSeconds.toLocaleString("en-US")} vCPU-s and ${prices.cloudRun.freeTier.gibSeconds.toLocaleString("en-US")} GiB-s a month) and Cloud Build's ${prices.cloudBuild.freeMinutesPerMonth.toLocaleString("en-US")} free build-minutes would cover this whole run; the numbers above are before free tiers.`,
    totals: {
      compute: round(compute, 6),
      storage: round(storage, 6),
      ai: round(ai, 6),
      build: build ?? 0,
      androidVm: android.vmTotal,
      all: round(allTotal, 6),
    },
  };
}

const usd = (n: number | null, digits = 6) =>
  n === null ? "not measured" : `$${n.toFixed(digits)}`;

/** The markdown summary for the growth team. */
export function formatBaseline(b: CloudBaseline): string {
  const lines = [
    `# Cloud cost baseline (${b.costRun}, ${b.date.slice(0, 10)})`,
    "",
    `Engine ${b.engineVersion}${b.commit ? ` at ${b.commit.slice(0, 7)}` : ""}. Measured on: ${b.where.join(", ")}. Reproduce: \`${b.command}\`.`,
    "",
    ...b.measured.map((m) => `- ${m}`),
    "",
    "## Per test",
    "",
    "| | $ per test |",
    "|---|---|",
    `| Web, author (first run, AI included) | ${usd(b.perWebTest.author)} |`,
    `| Web, replay (unchanged app; evidence: failures, the default outside CI) | ${usd(b.perWebTest.replay, 8)} |`,
    `| Web, heal (AI included) | ${usd(b.perWebTest.heal)} |`,
    `| Android, replay | ${usd(b.perAndroidTest.replay)} |`,
    `| Android, author (AI included) | ${usd(b.perAndroidTest.author)} |`,
    "",
    `Fixed per-run overhead (the cheapest shape; container start, Node, browser, upload, 1-minute minimum): ${usd(b.fixedPerRunOverhead)}.${b.perAndroidTest.fixedPerVm !== null ? ` Android VM: ${usd(b.perAndroidTest.vmHour, 4)}/hour with its disk, ${usd(b.perAndroidTest.fixedPerVm, 4)} to create and set up one.` : ""}`,
    "",
    "## Per run of N web tests, by shape",
    "",
    "| Shape | Phase | 1 test | 10 tests | 20 tests | 50 tests | 100 tests |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const s of b.shapes)
    for (const phase of ["replay", "author", "heal"] as const) {
      const row = s.perRun.filter((r) => r.phase === phase);
      if (row.length === 0) continue;
      lines.push(
        `| ${s.shape} | ${phase} | ${row.map((r) => `$${r.usd.toFixed(5)}`).join(" | ")} |`,
      );
    }
  lines.push(
    "",
    "## Shapes",
    "",
    "| Shape | Tasks | $/s | Overhead s | Replay s/test | Replay $/test |",
    "|---|---|---|---|---|---|",
    ...b.shapes.map((s) => {
      const r = headline(s.phases).find((p) => p.phase === "replay" && p.fixture === "shop");
      return `| ${s.shape} | ${s.tasks} | ${s.ratePerSecond.toFixed(7)} | ${s.overheadSeconds} | ${r?.marginalSecondsPerTest ?? "–"} | ${r ? `$${r.total.toFixed(8)}` : "–"} |`;
    }),
    "",
    "## Per web test by evidence mode",
    "",
    "| Shape | Phase | Evidence | Variants | Tests | s/test | Compute | Storage + writes | AI | Total |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...b.shapes.flatMap((s) =>
      s.phases
        .filter((p) => p.fixture === "shop")
        .map(
          (p) =>
            `| ${s.shape} | ${p.phase} | ${p.evidence} | ${p.variants.length > 40 ? "every variant" : p.variants} | ${p.tests} | ${p.marginalSecondsPerTest} | $${p.compute.toFixed(8)} | $${(p.storage + p.operations).toFixed(8)} | $${p.ai.toFixed(6)} | $${p.total.toFixed(8)} |`,
        ),
    ),
    "",
    "## Measured",
    "",
    `${b.measurements.tasks} tasks, ${b.measurements.tests} test runs, ${b.measurements.wallSeconds} s of task time, ${b.measurements.cpuSeconds} CPU-s (${b.measurements.cpuSources.join(", ")}), peak memory ${b.measurements.peakMemoryMiB} MiB. Container start: ${b.measurements.containerStartMs.median ?? "not measured"} ms median${b.measurements.containerStartMs.max !== null ? `, ${b.measurements.containerStartMs.max} ms max` : ""}; Node start ${b.measurements.processStartMs} ms; setup ${b.measurements.setupMs} ms.`,
    "",
    "| Fixture | Evidence mode | Passing test MiB | Failing test MiB | Files per test |",
    "|---|---|---|---|---|",
    ...b.measurements.evidence.map(
      (e) => `| ${e.fixture} | ${e.mode} | ${e.passingMiB} | ${e.failingMiB} | ${e.filesPerTest} |`,
    ),
    "",
    "## One-off and idle",
    "",
    `Image build: ${b.oneOff.buildMinutes === null ? "not built in this run" : `${b.oneOff.buildMinutes} min, ${usd(b.oneOff.build, 4)}`}. AI: ${b.ai.calls} calls, ${usd(b.ai.listUsd, 4)}${b.ai.model ? ` (${b.ai.model})` : ""}.`,
    "",
    `Idle monthly cost: **${usd(b.idleMonthly.total, 4)}**.`,
    "",
    ...b.idleMonthly.items.map((i) => `- ${i.item}: ${usd(i.usd, 4)} (${i.note})`),
    "",
    b.freeTier,
    "",
    `Run total: compute ${usd(b.totals.compute, 4)}, storage ${usd(b.totals.storage, 6)}, AI ${usd(b.totals.ai, 4)}, build ${usd(b.totals.build, 4)}, Android VM ${usd(b.totals.androidVm, 4)}: **${usd(b.totals.all, 4)}**.`,
  );
  return `${lines.join("\n")}\n`;
}
