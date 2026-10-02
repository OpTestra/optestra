import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { ENV_PREFIX } from "@optestra/config";
import type { ModelCall, TestResult } from "@optestra/contract";
import { BudgetMeter, computeCost, priceAt } from "@optestra/models";
import { loadTest } from "@optestra/spec/node";
import { draftTest } from "../draft/project.js";
import { explainRun } from "../explain/explain.js";
import { applyHeals } from "../heal/review.js";
import { version } from "../index.js";
import { type RunTestsOptions, type RunTestsResult, runTests } from "../run/runner.js";
import {
  type AndroidFixture,
  androidFixture,
  mailpitRunning,
  projectCopy,
  rowsOf,
  runShopVariant,
  type ShopFixture,
  shopFixture,
} from "./fixtures.js";
import { fixtureMetrics, type Rate } from "./metrics.js";
import { entryId, type ModelEntry, modelsFor, withoutRecordings } from "./models.js";
import { engineCommit } from "./run.js";

// EVAL-0: the model comparison and the cost facts a pricing model needs. For
// each candidate (planner and fixer), on the shop and the Android fixture:
// authoring every test, its recordings replayed with no AI on every variant
// (false passes and fails), cosmetic with the model as fixer, drafts and an AI
// explain; then the AI share over repeated runs (LRN-5). Every cost is at LIST
// API prices from prices.yaml, also for calls billed to a subscription, so the
// numbers apply to hosted AI. Plus what costs no AI at all: replay time and CPU,
// browser / emulator overhead, evidence sizes per evidence mode. Each model runs
// once (the MODEL RULE: no retry loops).

export const COMPARISON_VERSION = 1;

const PASSWORD = "shop-demo-pass";
const DRAFT_SENTENCES = [
  "A returning user can log in and sees the dashboard",
  "A new project can be created and shows up in the projects list",
  "The settings page lets a user change their display name",
];

export interface Tokens {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
}

export interface CallTotals {
  calls: number;
  tokens: Tokens;
  /** At list API prices (prices.yaml), whatever the billing was. Null when a price is unknown. */
  listUsd: number | null;
  /** Calls billed to the user's subscription (0 to a run budget). */
  subscriptionCalls: number;
  /** Sum of the calls' own latency. */
  latencyMs: number;
}

export type Complexity = "simple" | "medium" | "complex";

export interface AuthoredTest extends CallTotals {
  test: string;
  complexity: Complexity;
  /** Action and check steps once flows are inlined. */
  steps: number;
  verdict: string;
  wallMs: number;
}

export interface StepCost extends CallTotals {
  test: string;
  index: number;
  wallMs: number;
}

export interface Summary {
  n: number;
  mean: number;
  p50: number;
  p90: number;
  max: number;
}

export interface FixtureComparison {
  fixture: "shop" | "android";
  quality: {
    tests: number;
    passedAfterAuthoring: number;
    stepsAuthored: number;
    checks: { total: number; rules: number; ai: number; exact: number; other: number };
    falsePass: Rate;
    falseFail: Rate;
    otherMismatches: string[];
    cosmetic: {
      tests: number;
      passedOrHealed: number;
      healedByFixer: number;
      healsWithoutAi: number;
    };
  };
  authoring: CallTotals & {
    wallMs: number;
    perTest: AuthoredTest[];
    byComplexity: Record<
      Complexity,
      { tests: number; listUsd: Summary; calls: Summary; wallMs: Summary }
    >;
    perStep: { listUsd: Summary; calls: Summary; wallMs: Summary; steps: number };
  };
  /** Each step the fixer redid on cosmetic. */
  heals: CallTotals & { heals: number; perHeal: { listUsd: Summary; calls: Summary } };
  replay: {
    aiCalls: number;
    listUsd: number;
    /** Wall time per test, correct, the model's recordings. */
    wallMsPerTest: Summary;
  };
  /** LRN-5: AI calls and list $ per run. */
  aiShare: Array<{ run: string; aiCalls: number; listUsd: number | null; wallMs: number }>;
  /** Every real call on this fixture (authoring, replays, both cosmetic runs). */
  realCalls: CallTotals;
}

export interface ModelComparison {
  model: string;
  /** Prompt versions the calls carried (planner, fixer, check, draft, explain). */
  promptVersions: Record<string, string>;
  /** The one call that showed the CLI accepts the model id. */
  cliCheck: { ok: boolean; message: string; calls: CallTotals } | null;
  fixtures: FixtureComparison[];
  drafts: Array<
    CallTotals & { sentence: string; status: string; lintClean: boolean; wallMs: number }
  >;
  explains: Array<CallTotals & { test: string; wallMs: number; ok: boolean }>;
  /** Every real call this model made, all parts together. */
  total: CallTotals;
  problem: string | null;
}

export interface NonModelFacts {
  replay: Array<{
    fixture: "shop" | "android";
    tests: number;
    wallMsPerTest: Summary;
    /** This process's CPU (the runner) per test. */
    runnerCpuMsPerTest: number;
    /** Machine-wide CPU per test (browser or emulator included), on an otherwise idle machine. */
    machineCpuMsPerTest: number;
    aiCalls: number;
  }>;
  overhead: Record<string, number | null>;
  evidence: Array<{
    fixture: "shop" | "android";
    mode: "full" | "failures" | "minimal";
    passing: EvidenceSize;
    failing: EvidenceSize;
  }>;
  decisions: Record<string, unknown>;
}

export interface EvidenceSize {
  tests: number;
  /** Mean MB per test, by kind. */
  mbPerTest: Record<string, number>;
  totalMbPerTest: number;
}

export interface ComparisonFile {
  comparisonVersion: number;
  kind: "model-comparison";
  date: string;
  engineVersion: string;
  commit: string | null;
  os: string;
  scripted: boolean;
  command: string;
  prices: Record<string, unknown>;
  models: ModelComparison[];
  facts: NonModelFacts | null;
  /** Why the facts are missing, when measuring them failed. */
  factsProblem: string | null;
}

// ── small helpers (pure; unit-tested) ─────────────────────────────────────────

const zeroTokens = (): Tokens => ({ input: 0, output: 0, cached: 0, cacheWrite: 0 });

/** The calls' totals at list prices: `model` names the price when a call doesn't. */
export function totals(calls: readonly ModelCall[], model: string): CallTotals {
  const tokens = zeroTokens();
  let listUsd: number | null = 0;
  let subscriptionCalls = 0;
  let latencyMs = 0;
  for (const call of calls) {
    tokens.input += call.tokens.input;
    tokens.output += call.tokens.output;
    tokens.cached += call.tokens.cached;
    tokens.cacheWrite += call.tokens.cacheWrite ?? 0;
    latencyMs += call.latencyMs;
    if (call.billing === "subscription") subscriptionCalls++;
    // The call's own list price when it has one (1.6); else priced here, the
    // provider's own price first (ollama-cloud:kimi-k3), then the bare model id.
    const usd =
      typeof call.listCostUsd === "number"
        ? call.listCostUsd
        : computeCost(
            {
              inputTokens: call.tokens.input,
              outputTokens: call.tokens.output,
              cachedInputTokens: call.tokens.cached,
              cacheWriteTokens: call.tokens.cacheWrite ?? 0,
            },
            priceAt(call.provider ?? "", call.model ?? model),
          );
    listUsd = listUsd === null || usd === null ? null : listUsd + usd;
  }
  return { calls: calls.length, tokens, listUsd, subscriptionCalls, latencyMs };
}

export function add(a: CallTotals, b: CallTotals): CallTotals {
  return {
    calls: a.calls + b.calls,
    tokens: {
      input: a.tokens.input + b.tokens.input,
      output: a.tokens.output + b.tokens.output,
      cached: a.tokens.cached + b.tokens.cached,
      cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite,
    },
    listUsd: a.listUsd === null || b.listUsd === null ? null : a.listUsd + b.listUsd,
    subscriptionCalls: a.subscriptionCalls + b.subscriptionCalls,
    latencyMs: a.latencyMs + b.latencyMs,
  };
}

export const none = (): CallTotals => ({
  calls: 0,
  tokens: zeroTokens(),
  listUsd: 0,
  subscriptionCalls: 0,
  latencyMs: 0,
});

/** n, mean, median, 90th percentile (nearest rank) and max. */
export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { n: 0, mean: 0, p50: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    n: sorted.length,
    mean: round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
    p50: round(rank(0.5)),
    p90: round(rank(0.9)),
    max: round(sorted.at(-1) ?? 0),
  };
}

/**
 * The brief's classes: simple (≤5 steps, no login), medium (a login flow, 6–10
 * steps), complex (>10 steps, an email/code, an upload or a matrix). The heavier
 * class wins when signals disagree.
 */
export function complexityOf(test: {
  steps: number;
  login: boolean;
  email: boolean;
  upload: boolean;
  matrix: boolean;
}): Complexity {
  if (test.steps > 10 || test.email || test.upload || test.matrix) return "complex";
  if (test.steps <= 5 && !test.login) return "simple";
  return "medium";
}

const callsOf = (test: TestResult): ModelCall[] => test.attempts.flatMap((a) => a.modelCalls);

/** Per-step cost: the calls each step of the first attempt made. */
function stepCosts(test: TestResult, model: string): StepCost[] {
  const byId = new Map(callsOf(test).map((c) => [c.id, c]));
  const first = test.attempts[0];
  if (!first) return [];
  return first.steps
    .filter((s) => s.modelCallIds.length > 0)
    .map((s) => ({
      test: test.file,
      index: s.index,
      wallMs: s.durationMs,
      ...totals(
        s.modelCallIds.flatMap((id) => (byId.has(id) ? [byId.get(id) as ModelCall] : [])),
        model,
      ),
    }));
}

async function classify(
  dir: string,
  test: TestResult,
): Promise<{ steps: number; complexity: Complexity }> {
  const loaded = await loadTest(dir, test.file, undefined, { seed: "eval" });
  const steps = loaded?.expanded.steps.filter((s) => s.kind !== "guard") ?? [];
  const text = steps.map((s) => s.text).join("\n");
  const flow =
    steps.some((s) => s.flowPath.length > 0) ||
    Boolean(loaded?.expanded.auth && loaded.expanded.auth !== "none");
  return {
    steps: steps.length,
    complexity: complexityOf({
      steps: steps.length,
      login: flow || /\blog ?in\b|\bsign ?in\b/i.test(text),
      email: /\binbox\b|email code|verification (email|code)|code from the email/i.test(text),
      upload: /\bupload\b/i.test(text),
      matrix: false,
    }),
  };
}

/** Rules, AI, exact checks in the recordings a run wrote. */
function recordedChecks(dir: string, run: RunTestsResult) {
  const out = { total: 0, rules: 0, ai: 0, exact: 0, other: 0, steps: 0 };
  for (const entry of run.recorded) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, entry.recording), "utf8")) as {
        steps?: unknown[];
        checks?: Array<{ generatedBy?: string }>;
      };
      out.steps += rec.steps?.length ?? 0;
      for (const check of rec.checks ?? []) {
        out.total++;
        if (check.generatedBy === "rules") out.rules++;
        else if (check.generatedBy === "ai") out.ai++;
        else if (check.generatedBy === "exact") out.exact++;
        else out.other++;
      }
    } catch {
      // Unreadable: counts for nothing.
    }
  }
  return out;
}

function byComplexity(perTest: readonly AuthoredTest[]) {
  const out = {} as FixtureComparison["authoring"]["byComplexity"];
  for (const c of ["simple", "medium", "complex"] as const) {
    const tests = perTest.filter((t) => t.complexity === c);
    out[c] = {
      tests: tests.length,
      listUsd: summarize(tests.map((t) => t.listUsd ?? 0)),
      calls: summarize(tests.map((t) => t.calls)),
      wallMs: summarize(tests.map((t) => t.wallMs)),
    };
  }
  return out;
}

/** The fixer's calls on the steps it redid (one heal per step), by step. */
function healCosts(run: RunTestsResult, model: string): CallTotals[] {
  const out: CallTotals[] = [];
  for (const test of run.tests) {
    const byId = new Map(callsOf(test).map((c) => [c.id, c]));
    for (const attempt of test.attempts)
      for (const step of attempt.steps) {
        const calls = step.modelCallIds
          .map((id) => byId.get(id))
          .filter((c): c is ModelCall => c !== undefined && c.role === "fixer");
        if (calls.length) out.push(totals(calls, model));
      }
  }
  return out;
}

const runTotals = (run: RunTestsResult, model: string) => totals(run.tests.flatMap(callsOf), model);

// ── one fixture, one model ────────────────────────────────────────────────────

export interface FixtureRunner {
  id: "shop" | "android";
  manifest: ShopFixture["manifest"];
  variants: readonly string[];
  /** A project copy with no recordings: every test gets authored. */
  freshCopy(): string;
  run(
    variant: string,
    dir: string,
    extra: Partial<RunTestsOptions>,
  ): Promise<{ run: RunTestsResult; ms: number }>;
  close(): Promise<void>;
  /** Android: how long opening a session takes (fresh install on the clean snapshot). */
  sessionOpenMs?(): Promise<number>;
}

export async function shopRunner(shop: ShopFixture, useMailpit: boolean): Promise<FixtureRunner> {
  return {
    id: "shop",
    manifest: shop.manifest,
    variants: shop.variants,
    freshCopy: () => {
      const dir = projectCopy(shop.dir, "eval-shop-");
      withoutRecordings(dir);
      return dir;
    },
    run: async (variant, dir, extra) => {
      const result = await runShopVariant(shop, variant, { useMailpit, dir, ...extra });
      return { run: result.run, ms: result.ms };
    },
    close: async () => {},
  };
}

export async function androidRunner(
  fixture: AndroidFixture,
  shop: ShopFixture,
): Promise<FixtureRunner> {
  const { launchEmulator } = await import("@optestra/android");
  const backend = await shop.module.startShop({
    variant: "correct",
    port: fixture.module.SHOP_PORT,
  });
  const emulator = await launchEmulator({});
  return {
    id: "android",
    manifest: fixture.manifest,
    variants: fixture.variants,
    freshCopy: () => {
      const dir = projectCopy(fixture.dir, "eval-android-");
      withoutRecordings(dir);
      return dir;
    },
    run: async (variant, dir, extra) => {
      const started = Date.now();
      const run = await runTests({
        projectDir: dir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...(process.env.ANDROID_HOME ? { ANDROID_HOME: process.env.ANDROID_HOME } : {}),
          [`${ENV_PREFIX}APP`]: fixture.module.apkPath(variant),
          SHOP_PASSWORD: PASSWORD,
        },
        emulator,
        mode: variant === "cosmetic" ? "normal" : "replay-only",
        retries: fixture.manifest.harness.retries,
        models: null,
        video: false,
        inbox: null,
        generateSpecs: false,
        beforeAttempt: async ({ attempt, session }) => {
          await session.hookRequest({
            method: "POST",
            target: attempt === 1 ? "/__test/reset?environment=1" : "/__test/reset",
          });
        },
        ...extra,
      });
      return { run, ms: Date.now() - started };
    },
    close: async () => {
      await emulator.close();
      await backend.stop();
    },
    sessionOpenMs: async () => {
      const { openAndroidSession } = await import("@optestra/android");
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const opened = await openAndroidSession({
          apk: fixture.module.apkPath("correct"),
          emulator,
          allowedDomains: [`10.0.2.2:${fixture.module.SHOP_PORT}`],
        });
        if (!opened.ok) continue;
        times.push(opened.session.timings().totalMs);
        await opened.session.close();
      }
      return summarize(times).p50;
    },
  };
}

async function compareOnFixture(
  runner: FixtureRunner,
  entry: ModelEntry,
  options: ComparisonOptions,
  budget: BudgetMeter,
  say: (line: string) => void,
): Promise<{
  result: FixtureComparison;
  problem: string | null;
  failedRun: string | null;
  dir: string;
}> {
  const id = entryId(entry);
  const model = entry.model;
  const dir = runner.freshCopy();
  const models = () => modelsFor(dir, entry, options, budget);
  let problem: string | null = null;

  // 1. Authoring every test (correct).
  say(`${id} · ${runner.id}: authoring every test…`);
  const authored = await runner.run("correct", dir, {
    mode: "normal",
    retries: 0,
    models: await models(),
  });
  const blocked = authored.run.tests.find((t) =>
    t.decidedBy.some(
      (d) =>
        d.kind === "blocked" && (d.reason === "ai_unavailable" || d.reason === "budget_exceeded"),
    ),
  );
  if (blocked) problem = `${runner.id} authoring was blocked: ${blocked.headline ?? ""}`;
  const perTest: AuthoredTest[] = [];
  const perStep: StepCost[] = [];
  for (const test of authored.run.tests) {
    const c = await classify(dir, test);
    perTest.push({
      test: test.file,
      complexity: c.complexity,
      steps: c.steps,
      verdict: test.verdict,
      wallMs: test.durationMs,
      ...totals(callsOf(test), model),
    });
    perStep.push(...stepCosts(test, model));
  }
  const checks = recordedChecks(dir, authored.run);
  say(
    `${id} · ${runner.id}: ${checks.steps} steps, ${checks.total} checks; ${authored.run.run.cost.aiCalls} calls`,
  );

  // 2. Its recordings with no AI on every variant but cosmetic; correct 9 times (LRN-5 runs 2–10).
  const rows = [];
  const aiShare: FixtureComparison["aiShare"] = [
    {
      run: "1 (authoring)",
      aiCalls: authored.run.run.cost.aiCalls,
      listUsd: runTotals(authored.run, model).listUsd,
      wallMs: authored.ms,
    },
  ];
  let failedRun: string | null = null;
  let replayWall: number[] = [];
  let replayAi = none();
  for (const variant of runner.variants.filter((v) => v !== "cosmetic")) {
    const replayed = await runner.run(variant, dir, {});
    rows.push(...(await rowsOf(runner.id, runner.manifest, variant, 1, replayed.run, dir)));
    replayAi = add(replayAi, runTotals(replayed.run, model));
    if (variant === "correct") {
      replayWall = replayed.run.tests.map((t) => t.durationMs);
      aiShare.push({
        run: "2 (replay)",
        aiCalls: replayed.run.run.cost.aiCalls,
        listUsd: runTotals(replayed.run, model).listUsd,
        wallMs: replayed.ms,
      });
    }
    if (!failedRun && replayed.run.tests.some((t) => t.verdict === "failed"))
      failedRun = replayed.run.dir;
  }
  for (let n = 3; n <= 10; n++) {
    const again = await runner.run("correct", dir, {});
    replayAi = add(replayAi, runTotals(again.run, model));
    aiShare.push({
      run: `${n} (replay)`,
      aiCalls: again.run.run.cost.aiCalls,
      listUsd: runTotals(again.run, model).listUsd,
      wallMs: again.ms,
    });
  }
  const metrics = fixtureMetrics(rows);
  say(`${id} · ${runner.id}: replayed with no AI (${replayAi.calls} calls)`);

  // 3. Cosmetic: the model as fixer; then its heals accepted and cosmetic again.
  const cosmetic = await runner.run("cosmetic", dir, { mode: "normal", models: await models() });
  const heals = healCosts(cosmetic.run, model);
  const healTotals = heals.reduce(add, none());
  const fixed = cosmetic.run.tests;
  aiShare.push({
    run: "cosmetic 1 (heals)",
    aiCalls: cosmetic.run.run.cost.aiCalls,
    listUsd: runTotals(cosmetic.run, model).listUsd,
    wallMs: cosmetic.ms,
  });
  try {
    await applyHeals(dir, cosmetic.run.dir, "all", { generateSpecs: false, labels: false });
  } catch (error) {
    say(
      `${id} · ${runner.id}: heals couldn't be accepted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const after = await runner.run("cosmetic", dir, { mode: "normal", models: await models() });
  aiShare.push({
    run: "cosmetic 2 (heals accepted)",
    aiCalls: after.run.run.cost.aiCalls,
    listUsd: runTotals(after.run, model).listUsd,
    wallMs: after.ms,
  });
  const healsMap = Object.values(cosmetic.run.heals);

  const authoringTotals = runTotals(authored.run, model);
  const realCalls = [
    authoringTotals,
    replayAi,
    runTotals(cosmetic.run, model),
    runTotals(after.run, model),
  ].reduce(add, none());
  return {
    problem,
    failedRun,
    dir,
    result: {
      fixture: runner.id,
      quality: {
        tests: authored.run.tests.length,
        passedAfterAuthoring: authored.run.tests.filter((t) => t.verdict === "passed").length,
        stepsAuthored: checks.steps,
        checks: {
          total: checks.total,
          rules: checks.rules,
          ai: checks.ai,
          exact: checks.exact,
          other: checks.other,
        },
        falsePass: metrics.falsePass,
        falseFail: metrics.falseFail,
        otherMismatches: metrics.otherMismatches,
        cosmetic: {
          tests: fixed.length,
          passedOrHealed: fixed.filter((t) => t.verdict === "passed" || t.verdict === "healed")
            .length,
          healedByFixer: healsMap.reduce((n, h) => n + h.byFixer, 0),
          healsWithoutAi: healsMap.reduce((n, h) => n + h.withoutAi, 0),
        },
      },
      authoring: {
        ...authoringTotals,
        wallMs: authored.ms,
        perTest,
        byComplexity: byComplexity(perTest),
        perStep: {
          steps: perStep.length,
          listUsd: summarize(perStep.map((s) => s.listUsd ?? 0)),
          calls: summarize(perStep.map((s) => s.calls)),
          wallMs: summarize(perStep.map((s) => s.wallMs)),
        },
      },
      heals: {
        ...healTotals,
        heals: heals.length,
        perHeal: {
          listUsd: summarize(heals.map((h) => h.listUsd ?? 0)),
          calls: summarize(heals.map((h) => h.calls)),
        },
      },
      replay: {
        aiCalls: replayAi.calls,
        listUsd: replayAi.listUsd ?? 0,
        wallMsPerTest: summarize(replayWall),
      },
      aiShare,
      realCalls,
    },
  };
}

// ── drafts and explains (shop) ─────────────────────────────────────────────────

async function drafts(
  shop: ShopFixture,
  entry: ModelEntry,
  options: ComparisonOptions,
  budget: BudgetMeter,
  say: (l: string) => void,
) {
  const dir = projectCopy(shop.dir, "eval-draft-");
  const server = await shop.module.startShop({ variant: "correct", port: 0 });
  const out: ModelComparison["drafts"] = [];
  try {
    for (const sentence of DRAFT_SENTENCES) {
      const started = Date.now();
      const result = await draftTest(sentence, {
        project: dir,
        baseUrl: server.url,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SHOP_PASSWORD: PASSWORD },
        models: await modelsFor(dir, entry, options, budget),
      });
      out.push({
        sentence,
        status: result.status,
        lintClean: result.lintClean,
        wallMs: Date.now() - started,
        ...totals(result.modelCalls, entry.model),
      });
      say(
        `${entryId(entry)}: draft "${sentence}": ${result.status}, ${result.modelCalls.length} calls`,
      );
    }
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

async function explains(
  runDir: string | null,
  dir: string,
  entry: ModelEntry,
  options: ComparisonOptions,
  budget: BudgetMeter,
) {
  const out: ModelComparison["explains"] = [];
  if (!runDir) return out;
  const tests = readdirSync(join(runDir, "tests"))
    .map((t) => {
      try {
        return JSON.parse(
          readFileSync(join(runDir, "tests", t, "result.json"), "utf8"),
        ) as TestResult;
      } catch {
        return null;
      }
    })
    .filter((t): t is TestResult => t !== null && t.verdict === "failed")
    .slice(0, 2);
  for (const test of tests) {
    const started = Date.now();
    const result = await explainRun(runDir, {
      test: test.testId,
      models: await modelsFor(dir, entry, options, budget),
      maxCalls: 1,
      budget,
    });
    const calls = result.explanations.flatMap((e) => e.modelCalls);
    out.push({
      test: test.file,
      ok: calls.some((c) => c.outcome === "ok"),
      wallMs: Date.now() - started,
      ...totals(calls, entry.model),
    });
  }
  return out;
}

// ── the CLI accepts the id ─────────────────────────────────────────────────────

async function cliCheck(
  dir: string,
  entry: ModelEntry,
  options: ComparisonOptions,
  budget: BudgetMeter,
) {
  const models = await modelsFor(dir, entry, options, budget);
  const reply = await models.complete("planner", {
    system: "Answer with the single word: ok",
    messages: [{ role: "user", content: [{ type: "text", text: "Say ok." }] }],
    maxOutputTokens: 16,
    temperature: 0,
    tags: { purpose: "eval-cli-check" },
  });
  const record = reply.record;
  const call = {
    id: "cli-check",
    role: "planner",
    provider: entry.provider,
    model: entry.model,
    startedAt: new Date().toISOString(),
    tokens: {
      input: record?.usage.inputTokens ?? 0,
      output: record?.usage.outputTokens ?? 0,
      cached: record?.usage.cachedInputTokens ?? 0,
      cacheWrite: record?.usage.cacheWriteTokens ?? 0,
    },
    costUsd: 0,
    latencyMs: record?.latencyMs ?? 0,
    attempts: 1,
    outcome: reply.ok ? "ok" : "error",
    ...(record?.billing === "subscription" ? { billing: "subscription" as const } : {}),
  } as ModelCall;
  return {
    ok: reply.ok,
    message: reply.ok
      ? `${reply.provider}/${reply.model} answered`
      : `${reply.message} ${reply.fix}`.trim(),
    calls: totals([call], entry.model),
  };
}

// ── facts that need no model ───────────────────────────────────────────────────

const machineCpuMs = () =>
  cpus().reduce((n, c) => n + c.times.user + c.times.sys + c.times.nice + c.times.irq, 0);

function evidenceOf(runDir: string, tests: readonly TestResult[], failing: boolean): EvidenceSize {
  const kindOf = (file: string) =>
    /\.webm$/.test(file)
      ? "video"
      : /\.zip$/.test(file)
        ? "trace"
        : /\.(png|jpe?g)$/.test(file)
          ? "screenshots"
          : /\.(log|har|txt)$/.test(file)
            ? "logs"
            : "other";
  const chosen = tests.filter((t) => (t.verdict === "passed") !== failing);
  const sums: Record<string, number> = { video: 0, trace: 0, screenshots: 0, logs: 0, other: 0 };
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name !== "result.json")
        sums[kindOf(entry.name)] = (sums[kindOf(entry.name)] ?? 0) + statSync(path).size;
    }
  };
  for (const t of chosen) walk(join(runDir, "tests", t.testId.replace(/[^A-Za-z0-9._@-]/g, "_")));
  const n = Math.max(1, chosen.length);
  const mb = (bytes: number) => Math.round((bytes / n / 1_048_576) * 1000) / 1000;
  const mbPerTest = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, mb(v)]));
  return {
    tests: chosen.length,
    mbPerTest,
    totalMbPerTest: mb(Object.values(sums).reduce((a, b) => a + b, 0)),
  };
}

async function nonModelFacts(
  shop: ShopFixture,
  useMailpit: boolean,
  android: AndroidFixture | null,
  say: (l: string) => void,
): Promise<NonModelFacts> {
  const facts: NonModelFacts = {
    replay: [],
    overhead: {},
    evidence: [],
    decisions: decisionFacts(shop.benchDir),
  };
  // Browser and session overhead.
  const browser = await import("@optestra/browser");
  let t = Date.now();
  const launched = await browser.launchBrowser({ browser: "chromium", headless: true });
  facts.overhead.browserLaunchMs = Date.now() - t;
  const server = await shop.module.startShop({ variant: "correct", port: 0 });
  const opens: number[] = [];
  for (let i = 0; i < 5; i++) {
    t = Date.now();
    const session = await browser.openSession({
      browser: launched,
      baseUrl: server.url,
      allowedDomains: ["127.0.0.1"],
    });
    opens.push(Date.now() - t);
    await session.close();
  }
  facts.overhead.webSessionOpenMs = summarize(opens).p50;
  await server.stop();
  await launched.close();

  const replayFacts = async (fixture: "shop" | "android", runner: FixtureRunner, dir: string) => {
    const cpu0 = process.cpuUsage();
    const m0 = machineCpuMs();
    const { run } = await runner.run("correct", dir, {});
    const self = process.cpuUsage(cpu0);
    const machine = machineCpuMs() - m0;
    const n = Math.max(1, run.tests.length);
    facts.replay.push({
      fixture,
      tests: run.tests.length,
      wallMsPerTest: summarize(run.tests.map((r) => r.durationMs)),
      runnerCpuMsPerTest: Math.round((self.user + self.system) / 1000 / n),
      machineCpuMsPerTest: Math.round(machine / n),
      aiCalls: run.run.cost.aiCalls,
    });
  };
  const evidenceFacts = async (
    fixture: "shop" | "android",
    runner: FixtureRunner,
    dir: string,
    failingVariant: string,
  ) => {
    for (const mode of ["full", "failures", "minimal"] as const) {
      const ok = await runner.run("correct", dir, { evidence: mode, video: true });
      const bad = await runner.run(failingVariant, dir, { evidence: mode, video: true });
      facts.evidence.push({
        fixture,
        mode,
        passing: evidenceOf(ok.run.dir, ok.run.tests, false),
        failing: evidenceOf(bad.run.dir, bad.run.tests, true),
      });
      say(`facts: ${fixture} evidence (${mode})`);
    }
  };

  const shopR = await shopRunner(shop, useMailpit);
  const shopDir = projectCopy(shop.dir, "eval-facts-shop-");
  try {
    await replayFacts("shop", shopR, shopDir);
    await evidenceFacts("shop", shopR, shopDir, "broken-total");
  } finally {
    rmSync(shopDir, { recursive: true, force: true });
  }
  if (android) {
    t = Date.now();
    const runner = await androidRunner(android, shop);
    facts.overhead.emulatorReadyMs = Date.now() - t;
    const dir = projectCopy(android.dir, "eval-facts-android-");
    try {
      await replayFacts("android", runner, dir);
      await evidenceFacts("android", runner, dir, "broken-login");
      facts.overhead.androidSessionOpenMs = (await runner.sessionOpenMs?.()) ?? null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await runner.close();
    }
  }
  return facts;
}

/**
 * What the decision layer costs: rules $0; Jev at its configured price per input
 * token (about 350 tokens per decision, measured in DEC-1); Laya local, $0; and
 * the share the rules decide on their own, from the committed decision evals.
 */
function decisionFacts(benchDir: string): Record<string, unknown> {
  const jevPrice = 0.042; // config defaults: decisions.jev.priceUsdPerMillionInputTokens
  const tokensPerDecision = 350;
  const out: Record<string, unknown> = {
    rules: { usdPerDecision: 0 },
    jev: {
      usdPerMillionInputTokens: jevPrice,
      tokensPerDecision,
      usdPerDecision: (jevPrice * tokensPerDecision) / 1_000_000,
      usdPer1000Decisions: (jevPrice * tokensPerDecision) / 1000,
    },
    laya: { usdPerDecision: 0, note: "runs locally through Ollaya" },
  };
  const evals = join(benchDir, "..", "packages", "decide", "evals", "baseline.json");
  if (existsSync(evals)) {
    try {
      out.rulesDecide = JSON.parse(readFileSync(evals, "utf8"));
    } catch {
      // Unreadable: left out.
    }
  }
  return out;
}

// ── the comparison ─────────────────────────────────────────────────────────────

export interface ComparisonOptions {
  entries: readonly ModelEntry[];
  android?: boolean;
  /** Run the shop (authoring, replays, cosmetic, drafts, explains). Default true; false = Android only. */
  shop?: boolean;
  scripted?: boolean;
  /** Measure the non-model facts too (default true). */
  facts?: boolean;
  env?: NodeJS.ProcessEnv;
  command?: string;
  now?: () => Date;
  budgetUsd?: number;
  onProgress?: (line: string) => void;
  /** Called with the file so far after each model and at the end, so a later crash loses nothing. */
  onSave?: (file: ComparisonFile) => void;
}

export async function runComparison(options: ComparisonOptions): Promise<ComparisonFile> {
  const say = options.onProgress ?? (() => {});
  const shop = await shopFixture();
  const useMailpit = await mailpitRunning();
  const androidCheck = options.android ? await androidFixture(options.env ?? process.env) : null;
  if (androidCheck && !androidCheck.ok) throw new Error(`Android: ${androidCheck.reason}`);
  const android = androidCheck?.ok ? androidCheck.fixture : null;
  const models: ModelComparison[] = [];
  const date = (options.now?.() ?? new Date()).toISOString();
  const prices: Record<string, unknown> = {};
  for (const entry of options.entries)
    prices[entry.model] = priceAt(entry.provider, entry.model) ?? null;
  const snapshot = (facts: NonModelFacts | null, factsProblem: string | null): ComparisonFile => ({
    comparisonVersion: COMPARISON_VERSION,
    kind: "model-comparison",
    date,
    engineVersion: version(),
    commit: engineCommit(shop.benchDir),
    os: `${process.platform} ${process.arch} (${cpus()[0]?.model ?? "cpu"}, ${cpus().length} cores)`,
    scripted: options.scripted ?? false,
    command:
      options.command ??
      `bench --compare ${options.entries.map(entryId).join(" ")}${options.android ? " --android" : ""}`,
    prices,
    models,
    facts,
    factsProblem,
  });
  for (const entry of options.entries) {
    const budget = new BudgetMeter("run", options.budgetUsd ?? 50, "eval budget");
    const id = entryId(entry);
    const comparison: ModelComparison = {
      model: id,
      promptVersions: {},
      cliCheck: null,
      fixtures: [],
      drafts: [],
      explains: [],
      total: none(),
      problem: null,
    };
    const scratch = projectCopy(shop.dir, "eval-check-");
    try {
      if (!options.scripted) {
        comparison.cliCheck = await cliCheck(scratch, entry, options, budget);
        say(`${id}: CLI check: ${comparison.cliCheck.message}`);
        if (!comparison.cliCheck.ok) {
          comparison.problem = `the CLI didn't accept the model: ${comparison.cliCheck.message}`;
          comparison.total = comparison.cliCheck.calls;
          models.push(comparison);
          options.onSave?.(snapshot(null, "not measured yet"));
          continue;
        }
      }
      if (options.shop !== false) {
        const shopR = await shopRunner(shop, useMailpit);
        const onShop = await compareOnFixture(shopR, entry, options, budget, say);
        comparison.fixtures.push(onShop.result);
        comparison.problem = onShop.problem;
        comparison.explains = await explains(onShop.failedRun, onShop.dir, entry, options, budget);
        rmSync(onShop.dir, { recursive: true, force: true });
        comparison.drafts = await drafts(shop, entry, options, budget, say);
      }
      if (android) {
        const runner = await androidRunner(android, shop);
        try {
          const onAndroid = await compareOnFixture(runner, entry, options, budget, say);
          comparison.fixtures.push(onAndroid.result);
          comparison.problem ??= onAndroid.problem;
          rmSync(onAndroid.dir, { recursive: true, force: true });
        } finally {
          await runner.close();
        }
      }
    } catch (error) {
      comparison.problem = error instanceof Error ? error.message : String(error);
      say(`${id}: stopped: ${comparison.problem}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    let total = comparison.cliCheck?.calls ?? none();
    for (const f of comparison.fixtures) total = add(total, f.realCalls);
    for (const d of comparison.drafts) total = add(total, d);
    for (const e of comparison.explains) total = add(total, e);
    comparison.total = total;
    comparison.promptVersions = await promptVersions();
    models.push(comparison);
    options.onSave?.(snapshot(null, "not measured yet"));
  }
  let facts: NonModelFacts | null = null;
  let factsProblem: string | null = options.facts === false ? "not asked for" : null;
  if (options.facts !== false) {
    try {
      facts = await nonModelFacts(shop, useMailpit, android, say);
    } catch (error) {
      factsProblem = error instanceof Error ? error.message : String(error);
      say(`facts: stopped: ${factsProblem}`);
    }
  }
  const file = snapshot(facts, factsProblem);
  options.onSave?.(file);
  return file;
}

async function promptVersions(): Promise<Record<string, string>> {
  const core = await import("../index.js");
  const c = core as unknown as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of [
    "PROMPT_VERSION",
    "ANDROID_PROMPT_VERSION",
    "FIXER_PROMPT_VERSION",
    "CHECK_PROMPT_VERSION",
    "DRAFT_PROMPT_VERSION",
    "EXPLAIN_PROMPT_VERSION",
  ])
    if (typeof c[key] === "string") out[key] = c[key] as string;
  return out;
}

/** Writes bench/results/<date>-model-comparison.json; returns the path. */
export function saveComparison(benchDir: string, file: ComparisonFile): string {
  const dir = join(benchDir, "results");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${file.date.slice(0, 10)}-model-comparison.json`);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}

// ── the summary table ──────────────────────────────────────────────────────────

function grid(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((c, i) => c.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? "?" : `$${n.toFixed(4)}`;
const mean = (values: readonly (number | null)[]) =>
  values.length ? values.reduce<number>((s, v) => s + (v ?? 0), 0) / values.length : 0;

export function formatComparison(file: ComparisonFile): string {
  const rows = [
    [
      "MODEL",
      "FIXTURE",
      "PASSED",
      "FALSE PASS",
      "FALSE FAIL",
      "COSMETIC OK",
      "$/TEST simple·medium·complex",
      "$/STEP p50·p90",
      "$/HEAL",
      "$/DRAFT",
      "S/TEST",
      "CALLS",
    ],
  ];
  for (const m of file.models)
    for (const f of m.fixtures) {
      const c = f.authoring.byComplexity;
      rows.push([
        m.model,
        f.fixture,
        `${f.quality.passedAfterAuthoring}/${f.quality.tests}`,
        `${f.quality.falsePass.count}/${f.quality.falsePass.of}`,
        `${f.quality.falseFail.count}/${f.quality.falseFail.of}`,
        `${f.quality.cosmetic.passedOrHealed}/${f.quality.cosmetic.tests}`,
        (["simple", "medium", "complex"] as const)
          .map((k) => (c[k].tests ? usd(c[k].listUsd.mean) : "-"))
          .join(" · "),
        `${usd(f.authoring.perStep.listUsd.p50)} · ${usd(f.authoring.perStep.listUsd.p90)}`,
        f.heals.heals ? usd(f.heals.perHeal.listUsd.mean) : "-",
        f.fixture === "shop" && m.drafts.length ? usd(mean(m.drafts.map((d) => d.listUsd))) : "-",
        `${(mean(f.authoring.perTest.map((t) => t.wallMs)) / 1000).toFixed(0)}`,
        String(f.realCalls.calls),
      ]);
    }
  const lines = [
    `Model comparison · engine ${file.engineVersion}${file.commit ? ` (${file.commit})` : ""} · ${file.date.slice(0, 10)} · ${file.os}${file.scripted ? " · SCRIPTED stand-in" : ""}`,
    `Costs at list API prices. Reproduce: ${file.command}`,
    "",
    grid(rows),
  ];
  for (const m of file.models) {
    lines.push(
      "",
      `${m.model}: ${m.total.calls} real calls, ${usd(m.total.listUsd)} at list prices${m.problem ? ` · STOPPED: ${m.problem}` : ""}`,
    );
    if (m.explains.length)
      lines.push(
        `  explain --ai: ${m.explains.map((e) => `${e.calls} call, ${usd(e.listUsd)}`).join("; ")}`,
      );
  }
  if (file.facts) {
    lines.push("", "No-model facts:");
    for (const r of file.facts.replay)
      lines.push(
        `  replay ${r.fixture}: ${(r.wallMsPerTest.mean / 1000).toFixed(1)} s/test (p90 ${(r.wallMsPerTest.p90 / 1000).toFixed(1)}), CPU ${r.machineCpuMsPerTest} ms/test machine-wide, ${r.aiCalls} AI calls`,
      );
    for (const [k, v] of Object.entries(file.facts.overhead)) lines.push(`  ${k}: ${v ?? "?"} ms`);
    for (const e of file.facts.evidence)
      lines.push(
        `  evidence ${e.fixture} ${e.mode}: ${e.passing.totalMbPerTest} MB/passing test, ${e.failing.totalMbPerTest} MB/failing test`,
      );
  }
  if (file.factsProblem) lines.push("", `No-model facts: missing (${file.factsProblem})`);
  return lines.join("\n");
}
