import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brand } from "@optestra/brand";
import type { Config } from "@optestra/config";
import { loadProject, processEnvSource } from "@optestra/config/node";
import type { TestResult } from "@optestra/contract";
import { BudgetMeter, createModels, type Models } from "@optestra/models";
import { version } from "../index.js";
import type { RunTestsResult } from "../run/runner.js";
import {
  mailpitRunning,
  projectCopy,
  rowsOf,
  runShopVariant,
  type ShopFixture,
  shopFixture,
} from "./fixtures.js";
import { fixtureMetrics, type Rate } from "./metrics.js";
import { engineCommit } from "./run.js";

// Model evals (MOD-9, LRN-10): the parts of Bench a model does, run with each
// candidate as planner and fixer on the shop:
//  1. authoring: every test recorded from scratch (planner; checks compiled,
//     rules first, the model only for lines rules can't map);
//  2. the model's recordings and checks replayed with NO AI on every variant
//     except cosmetic: its false passes and false fails (a weak check shows here);
//  3. cosmetic, in normal mode: the model as fixer heals what no-AI heals can't.
// Every number says which model, engine and date made it; results go to
// bench/results/. Each model runs once (the MODEL RULE: no retry loops).

export interface ModelEntry {
  provider: string;
  model: string;
}

/**
 * Providers the eval knows without project config: the named ones (their own
 * kind: routing pins, limits, credit checks) and OpenAI-compatible routers.
 */
export const ROUTER_PROVIDERS: Record<string, Record<string, string>> = {
  openrouter: { kind: "openrouter" },
  "ollama-cloud": { kind: "ollama-cloud" },
  opencode: {
    kind: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/v1",
    keySecret: "OPENCODE_API_KEY",
  },
};

/** "provider:model" (the model may contain "/" and ":"), e.g. openrouter:z-ai/glm-4.6. */
export function parseModelEntry(text: string): ModelEntry | null {
  const at = text.indexOf(":");
  if (at <= 0 || at === text.length - 1) return null;
  return { provider: text.slice(0, at), model: text.slice(at + 1) };
}

export const entryId = (e: ModelEntry) => `${e.provider}:${e.model}`;

/** Rough call count for one model on the shop (for asking before a real run). */
export function estimateCalls(fixture: ShopFixture): { low: number; high: number } {
  const tests = Object.keys(fixture.manifest.tests).length;
  // ~5 action steps a test (flows included), 1–2 planner calls each, a few check
  // compiles, and up to 6 fixer calls for each of ~3 misses on cosmetic.
  return { low: tests * 5 + 5, high: tests * 5 * 2 + 10 + 18 };
}

export interface ModelEvalResult {
  model: string;
  scripted: boolean;
  authoring: {
    tests: number;
    /** Tests that passed on the run that recorded them. */
    passed: number;
    stepsAuthored: number;
    checksCompiled: number;
    durationMs: number;
    aiCalls: number;
    costUsd: number;
    subscriptionCalls: number;
    tokens: { input: number; output: number };
  };
  /** The model's recordings replayed with no AI on every variant but cosmetic. */
  replay: {
    falsePass: Rate & { cases: string[] };
    falseFail: Rate & { cases: string[] };
    other: string[];
  };
  /** Convenience for the gate. */
  falsePasses: number;
  /** Cosmetic with the model as fixer. */
  fixer: {
    tests: number;
    passedOrHealed: number;
    healedByFixer: number;
    healsWithoutAi: number;
    aiCalls: number;
    costUsd: number;
  };
  /** When something stopped the eval (a budget, the plan limit, no key). */
  problem: string | null;
}

export interface ModelEvalFile {
  benchVersion: 1;
  kind: "model-eval";
  fixture: "shop";
  date: string;
  engineVersion: string;
  commit: string | null;
  scripted: boolean;
  command: string;
  models: ModelEvalResult[];
}

export interface ModelEvalOptions {
  entries: readonly ModelEntry[];
  /** A stand-in model that gives up on every step (CI): proves the pipeline, spends nothing. */
  scripted?: boolean;
  /** Per-model AI budget in USD (default 5). Subscription calls cost 0 to it. */
  budgetUsd?: number;
  env?: NodeJS.ProcessEnv;
  onProgress?: (line: string) => void;
  command?: string;
  now?: () => Date;
}

const sumTokens = (tests: readonly TestResult[]) =>
  tests.reduce(
    (t, r) => ({ input: t.input + r.ai.tokens.input, output: t.output + r.ai.tokens.output }),
    { input: 0, output: 0 },
  );

const subscriptionCalls = (tests: readonly TestResult[]) =>
  tests.reduce(
    (n, t) =>
      n +
      t.attempts.reduce(
        (m, a) => m + a.modelCalls.filter((c) => c.billing === "subscription").length,
        0,
      ),
    0,
  );

/** The project config with the candidate as both planner and fixer (and nothing else). */
function evalConfig(config: Config, entry: ModelEntry, scripted: boolean): Config {
  const models = (config as { models?: Record<string, unknown> }).models ?? {};
  const providers = { ...((models.providers as Record<string, unknown>) ?? {}) };
  const router = ROUTER_PROVIDERS[entry.provider];
  if (scripted)
    providers[entry.provider] = { kind: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1" };
  else if (router && !providers[entry.provider]) providers[entry.provider] = { ...router };
  // An eval scores the model even where an earlier eval marked it unsupported.
  const candidate = { ...entry, allowUnsupported: true };
  return {
    ...config,
    models: {
      ...models,
      providers,
      roles: { planner: [candidate], fixer: [candidate] },
      // The stand-in costs nothing (and says so, rather than "unknown").
      ...(scripted
        ? {
            prices: {
              ...((models.prices as Record<string, unknown>) ?? {}),
              [entry.model]: { input: 0, output: 0 },
            },
          }
        : {}),
      // A model eval is deliberate: one pass needs more than a run's everyday allowance.
      delegatedCallsPerRun: 400,
    },
  } as Config;
}

export async function modelsFor(
  dir: string,
  entry: ModelEntry,
  options: Pick<ModelEvalOptions, "env" | "scripted">,
  budget: BudgetMeter,
): Promise<Models> {
  const env = options.env ?? process.env;
  const loaded = loadProject(dir, { env });
  const config = evalConfig(loaded.config, entry, options.scripted ?? false);
  if (options.scripted) {
    const { scriptedModel } = await import("@optestra/models/testing");
    const stand = scriptedModel({
      toolCalls: [
        {
          name: "step_impossible",
          input: { reason: "scripted stand-in: Bench's CI mode has no real model" },
        },
      ],
    });
    return createModels({
      config,
      sources: [],
      env,
      languageModel: stand.languageModel,
      budgets: [budget],
      backoffMs: 1,
    });
  }
  return createModels({
    config,
    sources: [processEnvSource(env)],
    env,
    budgets: [budget],
  });
}

/** Removes the committed recordings of a project copy, so every test is authored. */
export function withoutRecordings(dir: string): void {
  const data = join(dir, "tests", brand.dataDirName);
  for (const name of readdirSync(data))
    if (name.endsWith(".steps.json")) rmSync(join(data, name), { force: true });
}

/** Steps and checks in the recordings a run wrote. */
function countRecorded(dir: string, run: RunTestsResult): { steps: number; checks: number } {
  let steps = 0;
  let checks = 0;
  for (const entry of run.recorded) {
    try {
      const recording = JSON.parse(readFileSync(join(dir, entry.recording), "utf8")) as {
        steps?: unknown[];
        checks?: unknown[];
      };
      steps += recording.steps?.length ?? 0;
      checks += recording.checks?.length ?? 0;
    } catch {
      // A recording that can't be read counts for nothing.
    }
  }
  return { steps, checks };
}

export async function runModelEval(options: ModelEvalOptions): Promise<ModelEvalFile> {
  const say = options.onProgress ?? (() => {});
  const shop = await shopFixture();
  const useMailpit = await mailpitRunning();
  const results: ModelEvalResult[] = [];
  for (const entry of options.entries) {
    const id = entryId(entry);
    const budget = new BudgetMeter("run", options.budgetUsd ?? 5, "bench --models budget");
    let problem: string | null = null;
    let dir: string | undefined;
    try {
      // 1. Authoring: the correct shop, every test recorded by this model.
      say(`${id}: authoring every shop test…`);
      dir = projectCopy(shop.dir, "bench-model-");
      withoutRecordings(dir);
      const authored = await runShopVariant(shop, "correct", {
        useMailpit,
        dir,
        mode: "normal",
        retries: 0,
        models: await modelsFor(dir, entry, options, budget),
      });
      const counted = countRecorded(dir, authored.run);
      const tests = authored.run.tests;
      const blocked = authored.run.tests.find((t) =>
        t.decidedBy.some(
          (d) =>
            d.kind === "blocked" &&
            (d.reason === "ai_unavailable" || d.reason === "budget_exceeded"),
        ),
      );
      if (blocked) problem = `authoring was blocked: ${blocked.headline ?? ""}`;
      const authoring: ModelEvalResult["authoring"] = {
        tests: tests.length,
        passed: tests.filter((t) => t.verdict === "passed").length,
        stepsAuthored: counted.steps,
        checksCompiled: counted.checks,
        durationMs: tests.reduce((n, t) => n + t.durationMs, 0),
        aiCalls: authored.run.run.cost.aiCalls,
        costUsd: authored.run.run.cost.usd,
        subscriptionCalls: subscriptionCalls(tests),
        tokens: sumTokens(tests),
      };
      say(
        `${id}: authored ${counted.steps} steps and ${counted.checks} checks; ${authoring.passed}/${authoring.tests} tests passed; ${authoring.aiCalls} calls`,
      );

      // 2. Its recordings, replayed with no AI on every variant but cosmetic.
      const rows = [];
      for (const variant of shop.variants.filter((v) => v !== "cosmetic")) {
        const replayed = await runShopVariant(shop, variant, { useMailpit, dir });
        rows.push(...(await rowsOf("shop", shop.manifest, variant, 1, replayed.run, dir)));
        say(`${id}: replayed ${variant} with its recordings (no AI)`);
      }
      const metrics = fixtureMetrics(rows);

      // 3. Cosmetic, with the model as fixer.
      const cosmetic = await runShopVariant(shop, "cosmetic", {
        useMailpit,
        dir,
        mode: "normal",
        models: await modelsFor(dir, entry, options, budget),
      });
      const fixed = cosmetic.run.tests;
      const heals = Object.values(cosmetic.run.heals);
      say(`${id}: cosmetic with the model as fixer`);
      results.push({
        model: id,
        scripted: options.scripted ?? false,
        authoring,
        replay: {
          falsePass: metrics.falsePass,
          falseFail: metrics.falseFail,
          other: metrics.otherMismatches,
        },
        falsePasses: metrics.falsePass.count,
        fixer: {
          tests: fixed.length,
          passedOrHealed: fixed.filter((t) => t.verdict === "passed" || t.verdict === "healed")
            .length,
          healedByFixer: heals.reduce((n, h) => n + h.byFixer, 0),
          healsWithoutAi: heals.reduce((n, h) => n + h.withoutAi, 0),
          aiCalls: cosmetic.run.run.cost.aiCalls,
          costUsd: cosmetic.run.run.cost.usd,
        },
        problem,
      });
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }
  return {
    benchVersion: 1,
    kind: "model-eval",
    fixture: "shop",
    date: (options.now?.() ?? new Date()).toISOString(),
    engineVersion: version(),
    commit: engineCommit(shop.benchDir),
    scripted: options.scripted ?? false,
    command: options.command ?? `bench --models ${options.entries.map(entryId).join(" ")}`,
    models: results,
  };
}

/** Writes a model eval to bench/results/<date>-shop-models.json; returns the path. */
export function saveModelEval(benchDir: string, file: ModelEvalFile): string {
  mkdirSync(join(benchDir, "results"), { recursive: true });
  const path = join(
    benchDir,
    "results",
    `${file.date.slice(0, 10)}-shop-${file.scripted ? "scripted" : "models"}.json`,
  );
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}
