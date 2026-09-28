// The Acme Shop fixture as a bench project, shared by bench:replay and perf:
// a private copy of the project, the shop variant, a replay run with no AI and
// a plain-Playwright run of the generated specs.

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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInbox } from "@testament/auth";
import { brand } from "@testament/brand";
import { ENV_PREFIX } from "@testament/config";
import { parseYaml } from "@testament/config/node";
import { type RunTestsOptions, type RunTestsResult, runTests } from "@testament/core/node";
import { shopInbox, startShop, type Variant } from "@testament/fixture-shop";

export const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const PASSWORD = "shop-demo-pass";
export const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";
const MAILPIT_SMTP = process.env.MAILPIT_SMTP ?? "127.0.0.1:1025";

export interface Expectation {
  verdict: string;
  step?: number;
  cause?: string;
  reason?: string;
}
export interface Manifest {
  variants: Record<string, { also_accept?: { passed?: string[] } }>;
  tests: Record<string, Record<string, string | Expectation>>;
  harness: { retries: number };
}

export const manifest = parseYaml(
  readFileSync(join(SHOP, "manifest.yaml"), "utf8"),
  "manifest.yaml",
).value as Manifest;

/** Is Mailpit answering? (Checked through the inbox adapter, like a run would.) */
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

export const startVariant = (variant: Variant, useMailpit: boolean) =>
  startShop({ variant, port: 0, ...(useMailpit ? { mailpitSmtp: MAILPIT_SMTP } : {}) });

/** A private copy of the shop project (config, tests, committed recordings): runs never touch the fixture. */
export function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "bench-replay-"));
  cpSync(join(SHOP, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(SHOP, "tests"), join(dir, "tests"), {
    recursive: true,
    filter: (source) => !/\.ts$/.test(source) && !source.includes(`${brand.dataDirName}/authoring`),
  });
  return dir;
}

const browserEnv = () =>
  process.env.PLAYWRIGHT_BROWSERS_PATH
    ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
    : {};

/**
 * Replays the shop's tests on one variant: --replay-only with no AI (normal mode
 * without a model for `cosmetic`), with the manifest's harness (a fresh
 * environment before the first attempt, a reset before a retry).
 */
export async function replayShop(
  variant: Variant,
  /** `keep`: leave the project copy for the caller (who removes `dir`). */
  options: { useMailpit: boolean; keep?: boolean } & Partial<RunTestsOptions>,
): Promise<{ run: RunTestsResult; ms: number; dir: string }> {
  const { useMailpit, keep, ...extra } = options;
  const dir = project();
  const shop = await startVariant(variant, useMailpit);
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
      ...(useMailpit ? {} : { inbox: shopInbox(shop) }),
      mode: variant === "cosmetic" ? "normal" : "replay-only",
      retries: manifest.harness.retries,
      models: null,
      video: false,
      generateSpecs: false,
      beforeAttempt: async ({ attempt, session }) => {
        await session.hookRequest({
          method: "POST",
          target: attempt === 1 ? "/__test/reset?environment=1" : "/__test/reset",
        });
      },
      ...extra,
    });
    return { run, ms: Date.now() - started, dir };
  } finally {
    await shop.stop();
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

function node(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
  /** The Playwright run alone (not generating the specs). */
  ms: number;
}

/** The generated specs run as plain Playwright (the LOOP-3 promise; the speed yardstick). */
export async function specShop(variant: Variant, useMailpit: boolean): Promise<SpecRun> {
  const dir = project();
  const { generateProject } = await import("@testament/codegen/node");
  const generated = await generateProject({ projectDir: dir, env: {} });
  if (!generated.ok) throw new Error(generated.problems.join("\n"));
  mkdirSync(join(dir, "node_modules", "@playwright"), { recursive: true });
  const playwright = join(SHOP, "node_modules", "@playwright", "test");
  symlinkSync(
    realpathSync(playwright),
    join(dir, "node_modules", "@playwright", "test"),
    "junction",
  );
  const shop = await startVariant(variant, useMailpit);
  const report = join(dir, "report.json");
  try {
    const started = Date.now();
    const output = await node(
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
