import type { CorpusFile, CorpusStyleResult } from "./corpus.js";
import type { CloudBaseline, CloudPrices, CostMeasurement } from "./cost.js";

// The cloud cost baseline as the growth team reads it (COST-0 run): the meter's
// report on the cloud tasks, plus the corpus (authoring cost and wrong verdicts
// per phrasing style and per test complexity), plus Android on the spot VM (a cold
// VM vs one from the reusable image), plus the idle month of what stays up. Pure;
// every input is a file the run wrote.

export type Complexity = "simple" | "medium" | "complex";

/** One `vm-run.json` from scripts/android-vm (MOB-3). */
export interface VmRun {
  kind: "android-vm-run";
  vm: {
    machineType: string;
    zone: string;
    fromReusableImage: boolean;
    diskGb: number;
    image: string;
  };
  phases: {
    createMs: number | null;
    sshReadyMs: number | null;
    setupMs: number | null;
    emulatorColdBootMs?: number | null;
    emulatorSnapshotBootMs?: number | null;
    buildMs: number | null;
    commandMs: number | null;
    imageCreateMs?: number | null;
  };
  command: string;
  exit: number;
  preempted: boolean;
  replay: {
    summary: {
      tests: number;
      match: number;
      healed: number;
      needsAi: number;
      mismatch: number;
      aiCalls: number;
    };
    wallMsPerTest: { p50: number; mean: number };
    evidenceBytes: { total: number; perTest: number };
    mismatches: unknown[];
  } | null;
  cost: { vmSeconds: number; hourlyUsd: number | null; usd: number | null };
}

/** What stays up between runs, read from gcloud after the run. */
export interface IdleFacts {
  staging: { minInstances: number; vcpu: number; memoryGiB: number } | null;
  reaper: {
    invocationsPerMonth: number;
    secondsPerInvocation: number;
    vcpu: number;
    memoryGiB: number;
    schedulerJobs: number;
  } | null;
  /** Artifact Registry repos that stay (GiB). */
  registryGiB: number;
  /** Reusable Android images that stay until their ttl (GiB stored, ttl in minutes). */
  images: Array<{ name: string; gib: number; ttlMinutes: number | null }>;
}

export interface AiPricing {
  /** Off-peak multiplier for the model (DeepSeek on Ollama: 0.5 outside 12:00–18:00 UTC on weekdays, all weekend). */
  offPeakFactor: number | null;
  offPeakWindow: string | null;
}

export interface StyleCost {
  fixture: string;
  style: string;
  route: string;
  entries: number;
  lint: CorpusStyleResult["lint"];
  authoredPassed: string;
  wrongPasses: string;
  wrongFails: string;
  /** Per test: AI calls, AI list $ (drafting included for descriptions), off-peak, cloud compute, all-in. */
  perTest: {
    calls: number;
    aiUsd: number;
    aiOffPeakUsd: number | null;
    computeUsd: number;
    authorUsd: number;
  };
  /** Cosmetic pass with the fixer, per test. */
  heal: { calls: number; aiUsd: number; healedByFixer: number; passedOrHealed: string };
  wallMinutes: number;
}

export interface AndroidPath {
  path: "cold" | "image";
  /** The VM's measured work (create, ssh, setup, build, replay), what the per-test price uses. */
  vmSeconds: number;
  /** From create to the end of the script (a lost run or idle time included): what the bill shows. */
  vmSecondsActual: number;
  phasesSeconds: Record<string, number | null>;
  tests: number;
  /** The whole VM (create, setup or not, the replay) over the tests it ran. */
  perTestAllIn: number;
  /** Only the replay's VM time, per test: what one more test costs on a VM that is up. */
  perTestMarginal: number;
  vmUsd: number;
  /** Kept apart from cost: tests that didn't give the manifest's verdict. */
  flakiness: { match: number; healed: number; needsAi: number; mismatch: number; tests: number };
}

export interface CostBaselineFile {
  baselineVersion: 1;
  kind: "cost-baseline";
  costRun: string;
  date: string;
  model: string | null;
  measured: string[];
  cloud: CloudBaseline;
  cheapestGoodShape: {
    shape: string;
    replayPerTest: number;
    twentyTestsSeconds: number;
    runOf20Usd: number;
  } | null;
  perRunOf20: Array<{ shape: string; good: boolean; seconds: number; usd: number }>;
  styles: StyleCost[];
  perComplexity: Array<{
    complexity: Complexity;
    tests: number;
    aiUsd: number;
    aiOffPeakUsd: number | null;
    computeUsd: number;
    authorUsd: number;
  }>;
  android: { paths: AndroidPath[]; corpus: StyleCost[] };
  ai: {
    model: string | null;
    calls: number;
    listUsd: number;
    offPeakUsd: number | null;
    offPeakWindow: string | null;
    reported: { ollamaUsageUsd: number | null };
  };
  idleMonthly: { total: number; items: Array<{ item: string; usd: number; note: string }> };
  notes: string[];
}

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

/** Cloud compute of authoring one web test (the cloud author task), or null when not measured. */
function cloudAuthorCompute(cloud: CloudBaseline): number {
  const author = cloud.shapes
    .flatMap((s) => s.phases)
    .find((p) => p.phase === "author" && p.fixture === "shop");
  return author ? author.compute + author.storage + author.operations : 0;
}

function styleCost(s: CorpusStyleResult, compute: number, ai: AiPricing): StyleCost {
  const authored = Math.max(1, s.entries);
  const aiUsd = (s.drafts.listUsd ?? 0) + (s.authoring.listUsd ?? 0);
  const calls = s.drafts.calls + s.authoring.calls;
  const cosmeticTests = Math.max(1, s.cosmetic.tests);
  return {
    fixture: s.fixture,
    style: s.style,
    route: s.route,
    entries: s.entries,
    lint: s.lint,
    authoredPassed: `${s.authoring.passed}/${s.authoring.tests}`,
    wrongPasses: `${s.falsePass.count}/${s.falsePass.of}`,
    wrongFails: `${s.falseFail.count}/${s.falseFail.of}`,
    perTest: {
      calls: round(calls / authored, 2),
      aiUsd: round(aiUsd / authored),
      aiOffPeakUsd: ai.offPeakFactor === null ? null : round((aiUsd / authored) * ai.offPeakFactor),
      computeUsd: round(compute),
      authorUsd: round(aiUsd / authored + compute),
    },
    heal: {
      calls: round(s.cosmetic.calls / cosmeticTests, 2),
      aiUsd: round((s.cosmetic.listUsd ?? 0) / cosmeticTests),
      healedByFixer: s.cosmetic.healedByFixer,
      passedOrHealed: `${s.cosmetic.passedOrHealed}/${s.cosmetic.tests}`,
    },
    wallMinutes: round(s.total.wallMs / 60_000, 1),
  };
}

function androidPath(run: VmRun, prices: CloudPrices): AndroidPath {
  const hourly =
    (run.cost.hourlyUsd ?? prices.compute.spot[run.vm.machineType]?.hour ?? 0) +
    (run.vm.diskGb * prices.compute.pdBalancedGibMonth) / prices.hoursPerMonth;
  const tests = run.replay?.summary.tests ?? 0;
  // The VM's work: create, ssh ready, setup (cold only), build, the replay. A VM that
  // was up longer (a retried or lost run) shows that in vmSecondsActual, not here.
  const ph = run.phases;
  const parts = [ph.createMs, ph.sshReadyMs, ph.setupMs, ph.buildMs, ph.commandMs];
  const measured = parts.every((x) => x === null || typeof x === "number")
    ? parts.reduce((n: number, x) => n + (x ?? 0), 0) / 1000
    : run.cost.vmSeconds;
  const vmSeconds = measured > 0 ? measured : run.cost.vmSeconds;
  const vmUsd = (vmSeconds / 3600) * hourly;
  const s = (ms: number | null | undefined) =>
    ms === null || ms === undefined ? null : round(ms / 1000, 1);
  return {
    path: run.vm.fromReusableImage ? "image" : "cold",
    vmSeconds: round(vmSeconds, 1),
    vmSecondsActual: round(run.cost.vmSeconds, 1),
    phasesSeconds: {
      create: s(run.phases.createMs),
      sshReady: s(run.phases.sshReadyMs),
      setup: s(run.phases.setupMs),
      emulatorColdBoot: s(run.phases.emulatorColdBootMs),
      emulatorSnapshotBoot: s(run.phases.emulatorSnapshotBootMs),
      build: s(run.phases.buildMs),
      replay: s(run.phases.commandMs),
    },
    tests,
    perTestAllIn: tests ? round(vmUsd / tests) : 0,
    perTestMarginal: tests
      ? round((((run.phases.commandMs ?? 0) / 1000 / 3600) * hourly) / tests)
      : 0,
    vmUsd: round(vmUsd),
    flakiness: {
      match: run.replay?.summary.match ?? 0,
      healed: run.replay?.summary.healed ?? 0,
      needsAi: run.replay?.summary.needsAi ?? 0,
      mismatch: run.replay?.summary.mismatch ?? 0,
      tests,
    },
  };
}

function idleMonthly(
  idle: IdleFacts,
  prices: CloudPrices & {
    cloudRun: { services?: Record<string, number> };
    cloudScheduler?: { jobMonth: number; freeJobsPerAccount: number };
    compute: { imageGibMonth?: number };
  },
) {
  const svc = prices.cloudRun.services ?? {};
  const items: Array<{ item: string; usd: number; note: string }> = [];
  if (idle.staging) {
    const seconds = idle.staging.minInstances * prices.hoursPerMonth * 3600;
    items.push({
      item: "Staging web app (Cloud Run service)",
      usd: round(
        seconds *
          (idle.staging.vcpu * (svc.vcpuSecondIdleMinInstance ?? 0) +
            idle.staging.memoryGiB * (svc.gibSecondIdleMinInstance ?? 0)),
        4,
      ),
      note: `min instances ${idle.staging.minInstances}: ${idle.staging.minInstances === 0 ? "scales to zero, billed only while serving" : "a warm instance idles"}`,
    });
  }
  if (idle.reaper) {
    const r = idle.reaper;
    const seconds = r.invocationsPerMonth * r.secondsPerInvocation;
    const run =
      seconds * (r.vcpu * (svc.vcpuSecondActive ?? 0) + r.memoryGiB * (svc.gibSecondActive ?? 0)) +
      (r.invocationsPerMonth / 1e6) * (svc.requestsPerMillion ?? 0);
    const sched = prices.cloudScheduler
      ? Math.max(0, r.schedulerJobs - prices.cloudScheduler.freeJobsPerAccount) *
        prices.cloudScheduler.jobMonth
      : 0;
    items.push({
      item: "VM reaper (Cloud Run service + Cloud Scheduler)",
      usd: round(run + sched, 4),
      note: `${r.invocationsPerMonth} calls a month × ${r.secondsPerInvocation} s at ${r.vcpu} vCPU / ${r.memoryGiB} GiB (list, inside Cloud Run's free tier); ${r.schedulerJobs} scheduler job(s), ${prices.cloudScheduler?.freeJobsPerAccount ?? 0} free per billing account`,
    });
  }
  items.push({
    item: "Artifact Registry (images that stay)",
    usd: round(
      Math.max(0, idle.registryGiB - prices.artifactRegistry.freeGibMonth) *
        prices.artifactRegistry.gibMonth,
      4,
    ),
    note: `${idle.registryGiB.toFixed(2)} GiB, first ${prices.artifactRegistry.freeGibMonth} GiB-month free; the cost-run repo is deleted`,
  });
  for (const image of idle.images)
    items.push({
      item: `Android image ${image.name}`,
      usd: round(image.gib * (prices.compute.imageGibMonth ?? 0), 4),
      note: `${image.gib.toFixed(2)} GiB stored at $${prices.compute.imageGibMonth ?? 0}/GiB-month${image.ttlMinutes ? `; deleted after its ttl (${Math.round(image.ttlMinutes / 1440)} days)` : ""}`,
    });
  return {
    total: round(
      items.reduce((n, i) => n + i.usd, 0),
      4,
    ),
    items,
  };
}

export function assembleBaseline(input: {
  cloud: CloudBaseline;
  corpus: readonly CorpusFile[];
  vmRuns: readonly VmRun[];
  measurements: readonly CostMeasurement[];
  prices: CloudPrices;
  complexity: Record<string, Complexity>;
  ai: AiPricing;
  idle: IdleFacts;
  ollamaUsageUsd?: number | null;
  /** Reconciliation and run notes, shown at the end. */
  notes?: readonly string[];
}): CostBaselineFile {
  const { cloud, prices } = input;
  const compute = cloudAuthorCompute(cloud);
  const styles = input.corpus
    .flatMap((f) => f.styles)
    .filter((s) => s.fixture === "shop")
    .map((s) => styleCost(s, compute, input.ai));
  const androidCorpus = input.corpus
    .flatMap((f) => f.styles)
    // Android has no description route (drafting is web only): those rows are empty.
    .filter((s) => s.fixture === "android" && s.route !== "description")
    .map((s) => styleCost(s, 0, input.ai));

  // Per complexity: every web entry's authoring (with its draft), across styles.
  const byComplexity = new Map<Complexity, { tests: number; ai: number }>();
  for (const s of input.corpus.flatMap((f) => f.styles).filter((x) => x.fixture === "shop"))
    for (const e of s.perEntry) {
      const c = input.complexity[e.gold];
      if (!c) continue;
      const row = byComplexity.get(c) ?? { tests: 0, ai: 0 };
      row.tests++;
      row.ai += (e.authoring.listUsd ?? 0) + (e.draft?.listUsd ?? 0);
      byComplexity.set(c, row);
    }
  const perComplexity = (["simple", "medium", "complex"] as const)
    .filter((c) => byComplexity.has(c))
    .map((c) => {
      const row = byComplexity.get(c) as { tests: number; ai: number };
      const ai = row.ai / row.tests;
      return {
        complexity: c,
        tests: row.tests,
        aiUsd: round(ai),
        aiOffPeakUsd: input.ai.offPeakFactor === null ? null : round(ai * input.ai.offPeakFactor),
        computeUsd: round(compute),
        authorUsd: round(ai + compute),
      };
    });

  const perRunOf20 = cloud.shapes
    .map((s) => {
      const r = s.perRun.find((x) => x.tests === 20 && x.phase === "replay");
      return r
        ? { shape: s.shape, good: s.good, seconds: s.twentyTestsSeconds ?? r.seconds, usd: r.usd }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const good = cloud.shapes
    .filter((s) => s.good)
    .map((s) => {
      const replay = s.phases.find(
        (p) =>
          p.phase === "replay" &&
          p.fixture === "shop" &&
          p.variants === "correct" &&
          p.evidence === "failures",
      );
      const run20 = s.perRun.find((x) => x.tests === 20 && x.phase === "replay");
      return replay && run20 && s.twentyTestsSeconds !== null
        ? {
            shape: s.shape,
            replayPerTest: replay.total,
            twentyTestsSeconds: s.twentyTestsSeconds,
            runOf20Usd: run20.usd,
          }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.runOf20Usd - b.runOf20Usd || a.replayPerTest - b.replayPerTest);

  const corpusCalls = input.corpus.flatMap((f) => f.styles).reduce((n, s) => n + s.total.calls, 0);
  const corpusUsd = input.corpus
    .flatMap((f) => f.styles)
    .reduce((n, s) => n + (s.total.listUsd ?? 0), 0);
  const listUsd = corpusUsd + cloud.ai.listUsd;
  return {
    baselineVersion: 1,
    kind: "cost-baseline",
    costRun: cloud.costRun,
    date: cloud.date,
    model: input.corpus[0]?.model ?? cloud.ai.model,
    measured: [
      ...cloud.measured,
      "Corpus: every entry authored once on the model as planner and fixer (one pass, no retries); its recordings replayed with no AI on every variant; one cosmetic pass with the fixer. Per-test author cost = AI (drafting included for descriptions) + the cloud's compute for authoring one test.",
      "Android: MOB-3's spot VM (n2-standard-4, nested virtualization, 30 GiB pd-balanced). Cold = create + setup + replay; image = a VM from the reusable image + replay. Flakiness (tests that didn't give the manifest's verdict) is reported apart from cost; their VM time is in the cost.",
    ],
    cloud,
    cheapestGoodShape: good[0] ?? null,
    perRunOf20,
    styles,
    perComplexity,
    android: {
      paths: input.vmRuns.filter((r) => r.replay !== null).map((r) => androidPath(r, prices)),
      corpus: androidCorpus,
    },
    ai: {
      model: input.corpus[0]?.model ?? cloud.ai.model,
      calls: corpusCalls + cloud.ai.calls,
      listUsd: round(listUsd),
      offPeakUsd: input.ai.offPeakFactor === null ? null : round(listUsd * input.ai.offPeakFactor),
      offPeakWindow: input.ai.offPeakWindow,
      reported: { ollamaUsageUsd: input.ollamaUsageUsd ?? null },
    },
    idleMonthly: idleMonthly(input.idle, prices as never),
    notes: [...(input.notes ?? [])],
  };
}

const usd = (n: number | null | undefined, d = 4) =>
  n === null || n === undefined ? "–" : `$${n.toFixed(d)}`;

export function formatCostBaseline(b: CostBaselineFile): string {
  const c = b.cloud;
  const lines: string[] = [
    `# Cost baseline ${b.costRun} (${b.date.slice(0, 10)})`,
    "",
    `Model ${b.model ?? "none"} as planner and fixer. Engine ${c.engineVersion}${c.commit ? ` at ${c.commit.slice(0, 7)}` : ""}. Prices: ${c.prices.file}, checked ${c.prices.checked}, list before free tiers.`,
    "",
    ...b.measured.map((m) => `- ${m}`),
    "",
    "## Headline numbers",
    "",
    "| | $ |",
    "|---|---|",
    `| Web test, author (AI + cloud), tidy style | ${usd(b.styles.find((s) => s.style === "tidy")?.perTest.authorUsd, 5)} |`,
    `| Web test, replay (cheapest good shape) | ${usd(b.cheapestGoodShape?.replayPerTest, 8)} |`,
    `| Web test, heal (cloud cosmetic pass, per test) | ${usd(c.perWebTest.heal, 6)} |`,
    `| Run of 20 web tests (cheapest good shape) | ${usd(b.cheapestGoodShape?.runOf20Usd, 5)} |`,
    `| Fixed overhead per run (cheapest shape) | ${usd(c.fixedPerRunOverhead, 5)} |`,
    ...b.android.paths.map(
      (p) =>
        `| Android test, ${p.path === "cold" ? "cold VM" : "VM from the image"}: all-in / marginal | ${usd(p.perTestAllIn, 5)} / ${usd(p.perTestMarginal, 6)} |`,
    ),
    `| Idle month (staging, reaper, registry, image) | ${usd(b.idleMonthly.total, 4)} |`,
    `| AI for the whole run: ${b.ai.calls} calls | ${usd(b.ai.listUsd, 4)} list${b.ai.offPeakUsd !== null ? `, ${usd(b.ai.offPeakUsd, 4)} off-peak` : ""}${b.ai.reported.ollamaUsageUsd !== null ? `; Ollama usage page ${usd(b.ai.reported.ollamaUsageUsd, 4)}` : ""} |`,
    "",
    b.cheapestGoodShape
      ? `Cheapest good shape: **${b.cheapestGoodShape.shape}**: every correct replay passed, 20 tests in ${b.cheapestGoodShape.twentyTestsSeconds} s (CI-6: at most 600 s).`
      : "No shape met both the verdicts and CI-6's 10 minutes for 20 tests.",
    "",
    "## Shapes (web replay of the unchanged app, 110 test runs each)",
    "",
    "| Shape | Verdicts | s/test | 20 tests | Run of 20 | $/test |",
    "|---|---|---|---|---|---|",
    ...c.shapes.map((s) => {
      const r = s.phases.find(
        (p) => p.phase === "replay" && p.variants === "correct" && p.evidence === "failures",
      );
      const run20 = s.perRun.find((x) => x.tests === 20 && x.phase === "replay");
      return `| ${s.shape}${s.good ? " ✓" : ""} | ${s.verdicts.passed}/${s.verdicts.correctRuns} passed | ${r?.marginalSecondsPerTest ?? "–"} | ${s.twentyTestsSeconds ?? "–"} s | ${usd(run20?.usd, 5)} | ${usd(r?.total, 8)} |`;
    }),
    "",
    "## Per phrasing style (web): authoring and wrong verdicts",
    "",
    "| Style | Route | Lint ok/warn/rej | Authored passed | Wrong passes | Wrong fails | Calls/test | AI $/test | off-peak | Author $/test | Heal $/test |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...b.styles.map(
      (s) =>
        `| ${s.style} | ${s.route} | ${s.lint.clean}/${s.lint.warnings}/${s.lint.rejected} | ${s.authoredPassed} | ${s.wrongPasses} | ${s.wrongFails} | ${s.perTest.calls} | ${usd(s.perTest.aiUsd, 5)} | ${usd(s.perTest.aiOffPeakUsd, 5)} | ${usd(s.perTest.authorUsd, 5)} | ${usd(s.heal.aiUsd, 5)} |`,
    ),
    "",
    "## Per complexity (web, every style)",
    "",
    "| Complexity | Tests | AI $/test | off-peak | Author $/test |",
    "|---|---|---|---|---|",
    ...b.perComplexity.map(
      (p) =>
        `| ${p.complexity} | ${p.tests} | ${usd(p.aiUsd, 5)} | ${usd(p.aiOffPeakUsd, 5)} | ${usd(p.authorUsd, 5)} |`,
    ),
    "",
    "## Android",
    "",
    "| Path | VM s | Create | Setup | Replay | Tests | All-in $/test | Marginal $/test | VM $ | Verdicts (match / healed / needs AI / mismatch) |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...b.android.paths.map(
      (p) =>
        `| ${p.path} | ${p.vmSeconds} | ${p.phasesSeconds.create ?? "–"} s | ${p.phasesSeconds.setup ?? "–"} s | ${p.phasesSeconds.replay ?? "–"} s | ${p.tests} | ${usd(p.perTestAllIn, 5)} | ${usd(p.perTestMarginal, 6)} | ${usd(p.vmUsd, 4)} | ${p.flakiness.match} / ${p.flakiness.healed} / ${p.flakiness.needsAi} / ${p.flakiness.mismatch} |`,
    ),
    "",
    ...(b.android.corpus.length
      ? [
          "| Android style | Route | Authored passed | Wrong passes | Wrong fails | Calls/test | AI $/test |",
          "|---|---|---|---|---|---|---|",
          ...b.android.corpus.map(
            (s) =>
              `| ${s.style} | ${s.route} | ${s.authoredPassed} | ${s.wrongPasses} | ${s.wrongFails} | ${s.perTest.calls} | ${usd(s.perTest.aiUsd, 5)} |`,
          ),
          "",
        ]
      : []),
    "## Idle month",
    "",
    ...b.idleMonthly.items.map((i) => `- ${i.item}: ${usd(i.usd, 4)} (${i.note})`),
    `- Total: **${usd(b.idleMonthly.total, 4)}**`,
    "",
    ...(b.notes.length
      ? ["## Reconciliation and notes", "", ...b.notes.map((n) => `- ${n}`), ""]
      : []),
    "## The cloud tasks (meter)",
    "",
  ];
  return `${lines.join("\n")}\n`;
}
