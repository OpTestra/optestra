import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInbox } from "@testament/auth";
import { brand } from "@testament/brand";
import { ENV_PREFIX } from "@testament/config";
import { nodeRuntime, parseYaml } from "@testament/config/node";
import type { TestResult } from "@testament/contract";
import { loadTest } from "@testament/spec/node";
import { type RunTestsOptions, type RunTestsResult, runTests } from "../run/runner.js";
import {
  type BenchRow,
  expectation,
  type FixtureId,
  type Manifest,
  scoreResult,
  stepStats,
} from "./score.js";
import { portFree } from "./port.js";

// The Bench fixtures as the engine drives them: the shop website and the
// Android app, each from its committed recordings in a private copy of its
// project, with the manifest's harness (a fresh environment before the first
// attempt, a reset before a retry). The fixture packages live in the engine
// repository (bench/fixtures/*), not in the published packages, so they are
// loaded when Bench runs and a clear message says so when they're missing.

const PASSWORD = "shop-demo-pass";
export const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";
const MAILPIT_SMTP = process.env.MAILPIT_SMTP ?? "127.0.0.1:1025";

/** What Bench uses of `@testament/fixture-shop`. */
interface ShopModule {
  VARIANTS: readonly string[];
  startShop(options: {
    variant: string;
    port: number;
    mailpitSmtp?: string;
  }): Promise<{ url: string; stop(): Promise<void> }>;
  shopInbox(shop: unknown): NonNullable<RunTestsOptions["inbox"]>;
}

/** What Bench uses of `@testament/fixture-android`. */
interface AndroidModule {
  VARIANTS: readonly string[];
  FIXTURE_DIR: string;
  SHOP_PORT: number;
  apkPath(variant: string): string;
  apksBuilt(): boolean;
}

export class BenchSetupError extends Error {
  override name = "BenchSetupError";
}

// A variable specifier: the fixtures are workspace packages, not dependencies of core.
const load = async <T>(name: string): Promise<T> => {
  try {
    return (await import(name)) as T;
  } catch (error) {
    throw new BenchSetupError(
      `${name} isn't available (${error instanceof Error ? error.message.split("\n")[0] : String(error)}). Bench runs from the engine repository: clone it, pnpm install, pnpm build, and run ${brand.cliName} bench there.`,
    );
  }
};

export interface ShopFixture {
  id: "shop";
  dir: string;
  /** The repository's bench/ folder (baseline and results live there). */
  benchDir: string;
  variants: string[];
  manifest: Manifest;
  module: ShopModule;
}

export async function shopFixture(): Promise<ShopFixture> {
  const module = await load<ShopModule>("@testament/fixture-shop");
  const entry = fileURLToPath(import.meta.resolve("@testament/fixture-shop"));
  const dir = join(dirname(entry), "..");
  const manifest = parseYaml(readFileSync(join(dir, "manifest.yaml"), "utf8"), "manifest.yaml")
    .value as Manifest;
  return {
    id: "shop",
    dir,
    benchDir: join(dir, "..", ".."),
    variants: [...module.VARIANTS],
    manifest,
    module,
  };
}

/** The repository's bench/ folder, found through the shop fixture. */
export async function benchDir(): Promise<string> {
  return (await shopFixture()).benchDir;
}

/** A private copy of a fixture project (config, tests, committed recordings). */
export function projectCopy(fixtureDir: string, prefix = "bench-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(join(fixtureDir, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(fixtureDir, "tests"), join(dir, "tests"), {
    recursive: true,
    filter: (source) => !/\.ts$/.test(source) && !source.includes(`${brand.dataDirName}/authoring`),
  });
  return dir;
}

/** Is Mailpit answering? (Through the inbox adapter, like a run.) */
export async function mailpitRunning(): Promise<boolean> {
  const created = createInbox({
    secrets: {},
    inbox: {
      provider: "mailpit",
      timeoutSeconds: 5,
      mailpit: { url: MAILPIT_URL, domain: "example.test" },
      mailosaur: { baseUrl: "https://mailosaur.com", keySecret: "MAILOSAUR_API_KEY" },
      mailslurp: { baseUrl: "https://api.mailslurp.com", keySecret: "MAILSLURP_API_KEY" },
    },
  } as never);
  return created.ok && (await created.inbox.check()).ok;
}

const browserEnv = () =>
  process.env.PLAYWRIGHT_BROWSERS_PATH
    ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
    : {};

const harness = (attempt: number) =>
  attempt === 1 ? "/__test/reset?environment=1" : "/__test/reset";

/**
 * Runs the shop's tests on one variant: --replay-only with no AI (normal mode
 * with no model for `cosmetic`) unless `options` says otherwise.
 */
export async function runShopVariant(
  fixture: ShopFixture,
  variant: string,
  options: {
    useMailpit: boolean;
    /** Use this project folder (a model eval's freshly authored copy); kept. */
    dir?: string;
    /** Leave the project copy for the caller. */
    keep?: boolean;
  } & Partial<RunTestsOptions>,
): Promise<{ run: RunTestsResult; ms: number; dir: string }> {
  const { useMailpit, dir: given, keep, ...extra } = options;
  const dir = given ?? projectCopy(fixture.dir, "bench-shop-");
  const shop = await fixture.module.startShop({
    variant,
    port: 0,
    ...(useMailpit ? { mailpitSmtp: MAILPIT_SMTP } : {}),
  });
  const started = Date.now();
  try {
    const run = await runTests({
      projectDir: dir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...browserEnv(),
        [`${ENV_PREFIX}BASE_URL`]: shop.url,
        [`${ENV_PREFIX}INBOX_MAILPIT_URL`]: MAILPIT_URL,
        SHOP_PASSWORD: PASSWORD,
      },
      ...(useMailpit ? {} : { inbox: fixture.module.shopInbox(shop) }),
      mode: variant === "cosmetic" ? "normal" : "replay-only",
      retries: fixture.manifest.harness.retries,
      models: null,
      video: false,
      generateSpecs: false,
      beforeAttempt: async ({ attempt, session }) => {
        await session.hookRequest({ method: "POST", target: harness(attempt) });
      },
      ...extra,
    });
    return { run, ms: Date.now() - started, dir };
  } finally {
    await shop.stop();
    if (!given && !keep) rmSync(dir, { recursive: true, force: true });
  }
}

/** The .test.md step number where the (first failing, else final) attempt stopped; 0 = the auth login. */
export async function failingStep(dir: string, result: TestResult): Promise<number | null> {
  const attempt =
    result.attempts.find((a) => a.status !== "passed") ?? result.attempts.at(-1) ?? null;
  const step = attempt?.steps.find((s) => s.status === "failed" || s.status === "blocked");
  if (!step) return null;
  if (step.kind === "flow" && step.text.startsWith("auth: ")) return 0;
  const loaded = await loadTest(dir, result.file, undefined, { seed: "bench" });
  return loaded?.expanded.steps[step.index]?.origin[0]?.number ?? null;
}

/** Scores a run's results against the manifest, as Bench rows. */
export async function rowsOf(
  fixture: FixtureId,
  manifest: Manifest,
  variant: string,
  rerun: number,
  run: RunTestsResult,
  dir: string,
): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  for (const result of run.tests) {
    const test = result.file.replace(/^tests\//, "").replace(/\.test\.md$/, "");
    const expected = expectation(manifest, test, variant);
    const heals = run.heals[result.testId] ?? { withoutAi: 0, byFixer: 0, needsAi: 0 };
    const s = scoreResult(manifest, variant, expected, result, heals);
    const step = await failingStep(dir, result);
    rows.push({
      fixture,
      variant,
      test,
      rerun,
      expected,
      verdict: result.verdict,
      cause: result.failureCause,
      step,
      ...s,
      note:
        s.score === "match" && expected.step !== undefined && step !== expected.step
          ? `failure seen at step ${step} (manifest: ${expected.step})`
          : s.note,
      aiCalls: result.ai.calls,
      costUsd: result.ai.costUsd,
      heals,
      steps: stepStats(result),
      durationMs: result.durationMs,
    });
  }
  return rows;
}

// ── the generated specs as plain Playwright (equivalence, the speed yardstick) ──

interface ReportSuite {
  specs?: Array<{
    title: string;
    tests: Array<{ results: Array<{ status: string; duration: number }> }>;
  }>;
  suites?: ReportSuite[];
}

export interface SpecRun {
  /** Per test name: passed | failed | blocked (skipped). */
  verdicts: Record<string, string>;
  /** Per test name: Playwright's own duration of the test. */
  durations: Record<string, number>;
  ms: number;
}

function runNode(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const node = nodeRuntime({ env });
  return new Promise((resolve, reject) => {
    const child = spawn(node.command, args, {
      cwd,
      env: { ...env, ...node.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}

/** Generates the shop's portable specs and runs them with Playwright Test (one worker, chromium). */
export async function specShop(
  fixture: ShopFixture,
  variant: string,
  useMailpit: boolean,
): Promise<SpecRun> {
  const dir = projectCopy(fixture.dir, "bench-spec-");
  const { generateProject } = await import("@testament/codegen/node");
  const generated = await generateProject({ projectDir: dir, env: {} });
  if (!generated.ok) throw new Error(generated.problems.join("\n"));
  mkdirSync(join(dir, "node_modules", "@playwright"), { recursive: true });
  symlinkSync(
    realpathSync(join(fixture.dir, "node_modules", "@playwright", "test")),
    join(dir, "node_modules", "@playwright", "test"),
    "junction",
  );
  const shop = await fixture.module.startShop({
    variant,
    port: 0,
    ...(useMailpit ? { mailpitSmtp: MAILPIT_SMTP } : {}),
  });
  const report = join(dir, "report.json");
  try {
    const started = Date.now();
    const output = await runNode(
      [
        join(dir, "node_modules", "@playwright", "test", "cli.js"),
        "test",
        "-c",
        `tests/${brand.dataDirName}`,
        "--project=chromium",
        "--workers=1",
        "--retries=0",
        "--reporter=json",
      ],
      dir,
      {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...browserEnv(),
        PLAYWRIGHT_JSON_OUTPUT_NAME: report,
        [`${ENV_PREFIX}BASE_URL`]: shop.url,
        ...(useMailpit ? { [`${ENV_PREFIX}MAILPIT_URL`]: MAILPIT_URL } : {}),
        SHOP_PASSWORD: PASSWORD,
      },
    );
    const ms = Date.now() - started;
    if (!existsSync(report)) throw new Error(`plain Playwright wrote no report:\n${output}`);
    const json = JSON.parse(readFileSync(report, "utf8")) as { suites: ReportSuite[] };
    const verdicts: Record<string, string> = {};
    const durations: Record<string, number> = {};
    const walk = (suite: ReportSuite) => {
      for (const spec of suite.specs ?? []) {
        const result = spec.tests[0]?.results.at(-1);
        const status = result?.status ?? "none";
        verdicts[spec.title] =
          status === "passed" ? "passed" : status === "skipped" ? "blocked" : "failed";
        durations[spec.title] = result?.duration ?? 0;
      }
      for (const child of suite.suites ?? []) walk(child);
    };
    for (const suite of json.suites) walk(suite);
    return { verdicts, durations, ms };
  } finally {
    await shop.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Tests of a fixture that read an email (their specs need Mailpit). */
export async function emailTests(fixture: ShopFixture): Promise<Set<string>> {
  const found = new Set<string>();
  for (const name of Object.keys(fixture.manifest.tests)) {
    const loaded = await loadTest(fixture.dir, `tests/${name}.test.md`, undefined, {
      seed: "bench",
    });
    if (
      loaded &&
      /\binbox\b|verification email/i.test(loaded.expanded.steps.map((s) => s.text).join("\n"))
    )
      found.add(`tests/${name}.test.md`);
  }
  return found;
}

// ── Android ────────────────────────────────────────────────────────────────────

export interface AndroidFixture {
  id: "android";
  dir: string;
  variants: string[];
  manifest: Manifest;
  module: AndroidModule;
}

/** The Android fixture when it can run here, else why not (a clear line, never an error). */
export async function androidFixture(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; fixture: AndroidFixture } | { ok: false; reason: string }> {
  let module: AndroidModule;
  try {
    module = await load<AndroidModule>("@testament/fixture-android");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!module.apksBuilt())
    return {
      ok: false,
      reason:
        "the fixture APKs aren't built (pnpm --filter @testament/fixture-android build:apks).",
    };
  const { androidDoctor, DEFAULT_ANDROID_VERSION } = await import("@testament/android");
  const doctor = await androidDoctor(env);
  // Bench needs the default Android version's image, not every version's.
  const needed = doctor.checks.filter(
    (c) => !c.id.startsWith("image-") || c.id === `image-${DEFAULT_ANDROID_VERSION}`,
  );
  if (needed.some((c) => !c.ok)) {
    const failed = needed.filter((c) => !c.ok).map((c) => c.detail);
    return {
      ok: false,
      reason: `no Android emulator here: ${failed.join("; ")} (${brand.cliName} android setup).`,
    };
  }
  if (!(await portFree(module.SHOP_PORT)))
    return {
      ok: false,
      reason: `port ${module.SHOP_PORT} (the app's backend) is in use, probably by another Android run; try again when it's done.`,
    };
  const manifest = parseYaml(
    readFileSync(join(module.FIXTURE_DIR, "manifest.yaml"), "utf8"),
    "manifest.yaml",
  ).value as Manifest;
  return {
    ok: true,
    fixture: {
      id: "android",
      dir: module.FIXTURE_DIR,
      variants: [...module.VARIANTS],
      manifest,
      module,
    },
  };
}

/**
 * Runs every listed Android variant on one emulator, the shop's server (the
 * app's backend) on the port the APKs are built for.
 */
export async function runAndroidVariants(
  fixture: AndroidFixture,
  shopModule: ShopModule,
  variants: readonly string[],
  onVariant: (variant: string, run: RunTestsResult, ms: number, dir: string) => Promise<void>,
  onProgress?: (line: string) => void,
): Promise<void> {
  const { launchEmulator } = await import("@testament/android");
  const shop = await shopModule.startShop({ variant: "correct", port: fixture.module.SHOP_PORT });
  const emulator = await launchEmulator({ ...(onProgress ? { onProgress } : {}) });
  try {
    for (const variant of variants) {
      const dir = projectCopy(fixture.dir, "bench-android-");
      const started = Date.now();
      try {
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
          beforeAttempt: async ({ attempt, session }) => {
            await session.hookRequest({ method: "POST", target: harness(attempt) });
          },
        });
        if (run.run.blocked)
          throw new BenchSetupError(`${variant}: the run was blocked: ${run.run.blocked.message}`);
        await onVariant(variant, run, Date.now() - started, dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    await emulator.close();
    await shop.stop();
  }
}
