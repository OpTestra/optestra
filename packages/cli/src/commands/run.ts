import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { brand } from "@optestra/brand";
import { findProject, projectFile } from "@optestra/config/node";
import type { Event, RunMode } from "@optestra/contract";
import type { CommandIo } from "./config.js";

// `run [tests…]` (LOOP-4, CLI-2/4/5): replays every selected test from its
// recording with no AI, evaluates every check, prints one quiet line per test
// and a summary with the failure groups, writes a contract run folder, and
// exits with the CI code. The engine is imported only when this runs.

export interface RunCommandOptions {
  tag?: string[];
  grep?: string;
  shard?: string;
  env?: string;
  baseUrl?: string;
  replayOnly?: boolean;
  rerecord?: boolean;
  retries?: string;
  workers?: string;
  headed?: boolean;
  budget?: string;
  /** Repeatable: several make a matrix (TGT-5). A single string is accepted too. */
  browser?: string | string[];
  device?: string | string[];
  locale?: string;
  timezone?: string;
  /** A custom browser size, like 1280x720 (TGT-3). */
  viewport?: string;
  evidence?: string;
  /** Android projects: the Android version; repeatable (a matrix of versions × devices). */
  android?: string | string[];
  video?: boolean;
  recordNetwork?: boolean;
  accessibility?: boolean;
  liveNetwork?: boolean;
  verbose?: boolean;
  dir?: string;
  /** CLI-2 / CLOUD-2: run in the hosted cloud instead of on this machine. */
  cloud?: boolean;
  /** The cloud's address (default: the signed-in one, or <PREFIX>CLOUD_URL). */
  cloudUrl?: string;
}

const posix = (path: string) => path.split(sep).join("/");
const BROWSERS = ["chromium", "firefox", "webkit"] as const;
const EVIDENCE = ["full", "failures", "minimal"] as const;
const list = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function parseCount(value: string | undefined, what: string): number | undefined | string {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : `--${what} must be a whole number, not "${value}".`;
}

export async function runRunCommand(
  tests: string[],
  options: RunCommandOptions,
  io: CommandIo & { color?: boolean; signal?: AbortSignal },
): Promise<number> {
  const dir = options.dir
    ? resolve(io.cwd, options.dir)
    : (findProject(tests[0] ? resolve(io.cwd, tests[0]) : io.cwd) ?? io.cwd);
  if (!existsSync(projectFile(dir))) {
    io.stdout(`No project file found in ${dir}. Create one first (${brand.cliName} init).\n`);
    return 2;
  }
  if (options.recordNetwork && options.liveNetwork) {
    io.stdout("Choose one of --record-network and --live-network.\n");
    return 2;
  }
  if (options.replayOnly && options.rerecord) {
    io.stdout("Choose one of --replay-only and --rerecord.\n");
    return 2;
  }
  const retries = parseCount(options.retries, "retries");
  const workers = parseCount(options.workers, "workers");
  const budget =
    options.budget === undefined ? undefined : Number(options.budget.replace(/^\$/, ""));
  for (const problem of [retries, workers]) {
    if (typeof problem === "string") {
      io.stdout(`${problem}\n`);
      return 2;
    }
  }
  const browsers = list(options.browser);
  const devices = list(options.device);
  const androidVersions = list(options.android);
  const badBrowser = browsers.find((b) => !(BROWSERS as readonly string[]).includes(b));
  if (badBrowser) {
    io.stdout(`--browser must be chromium, firefox or webkit, not "${badBrowser}".\n`);
    return 2;
  }
  if (options.evidence && !(EVIDENCE as readonly string[]).includes(options.evidence)) {
    io.stdout(`--evidence must be full, failures or minimal, not "${options.evidence}".\n`);
    return 2;
  }
  let viewport: { width: number; height: number } | undefined;
  if (options.viewport !== undefined) {
    const { parseViewport } = await import("@optestra/core");
    const checked = parseViewport(options.viewport);
    if (!checked.ok) {
      io.stdout(`--viewport: ${checked.message}\n`);
      return 2;
    }
    viewport = checked.viewport;
  }
  if (budget !== undefined && !(budget >= 0)) {
    io.stdout(`--budget must be an amount in dollars, like 0.50, not "${options.budget}".\n`);
    return 2;
  }
  const mode: RunMode | undefined = options.replayOnly
    ? "replay-only"
    : options.rerecord
      ? "rerecord"
      : undefined;

  if (options.cloud) {
    for (const [flag, used] of [
      ["--shard", options.shard !== undefined],
      ["--headed", options.headed === true],
      ["--workers", options.workers !== undefined],
      ["--android", androidVersions.length > 0],
      ["--record-network", options.recordNetwork === true],
    ] as const)
      if (used) {
        io.stdout(
          `${flag} isn't used with --cloud: the cloud decides how a run is spread out and shown.\n`,
        );
        return 2;
      }
    return cloudRun(dir, tests, options, viewport, io);
  }

  const { parseShard, runTests } = await import("@optestra/core/node");
  const shard = options.shard === undefined ? undefined : parseShard(options.shard);
  if (typeof shard === "string") {
    io.stdout(`${shard}\n`);
    return 2;
  }
  const { exitCodeFor, formatDuration, stepLabel } = await import("@optestra/contract");
  const { loadProject } = await import("@optestra/config/node");
  const { ENV_PREFIX } = await import("@optestra/config");
  // --base-url (a preview deploy, CI-1/ENV-2): the environment's baseUrl for this run.
  const env = options.baseUrl ? { ...io.env, [`${ENV_PREFIX}BASE_URL`]: options.baseUrl } : io.env;
  const verbose = options.verbose ?? false;
  const names = new Map<string, string>();
  const onEvent = (event: Event) => {
    if (event.type === "run.started")
      io.stdout(
        `Running ${event.project}${event.environment ? ` on ${event.environment}` : ""} (${event.mode}${shard ? `, shard ${shard.index}/${shard.total}` : ""})\n`,
      );
    if (event.type === "test.started") names.set(event.testId, event.name);
    if (!verbose) return;
    if (event.type === "attempt.started" && event.attempt > 1)
      io.stdout(`  ${names.get(event.testId) ?? event.testId}: retry ${event.attempt - 1}\n`);
    if (event.type === "step.finished") {
      const step = event.step;
      const how =
        step.recovery === "replay" || step.recovery === "none" ? "" : ` (${step.recovery})`;
      io.stdout(
        `    ${stepLabel(step).padStart(2)}. ${step.text.slice(0, 64).padEnd(64)} ${step.status}${how} ${formatDuration(step.durationMs)}\n`,
      );
      if (step.error) io.stdout(`        ${step.error}\n`);
    }
    if (event.type === "heal.proposed")
      io.stdout(
        `        healed ${event.heal.level === "fixer" ? "by AI" : "without AI"}: ${event.heal.changes.map((c) => `${c.before} → ${c.after}`).join("; ")} (${event.heal.classification}, ${event.heal.status === "accepted" ? "applied: heal policy auto" : "pending review"})\n`,
      );
    if (event.type === "log" && event.level !== "debug") io.stdout(`  ${event.message}\n`);
  };

  let result: Awaited<ReturnType<typeof runTests>>;
  try {
    result = await runTests({
      projectDir: dir,
      tests,
      cwd: io.cwd,
      ...(options.tag?.length ? { tags: options.tag } : {}),
      ...(options.grep ? { grep: options.grep } : {}),
      ...(shard ? { shard } : {}),
      ...(options.env ? { environment: options.env } : {}),
      env,
      ...(mode ? { mode } : {}),
      ...(typeof retries === "number" ? { retries } : {}),
      ...(typeof workers === "number" && workers > 0 ? { workers } : {}),
      ...(budget !== undefined ? { budgetUsd: budget } : {}),
      headless: !options.headed,
      ...(browsers.length ? { browsers: browsers as (typeof BROWSERS)[number][] } : {}),
      ...(devices.length ? { devices } : {}),
      ...(options.locale ? { locale: options.locale } : {}),
      ...(options.timezone ? { timezone: options.timezone } : {}),
      ...(viewport ? { viewport } : {}),
      ...(options.evidence ? { evidence: options.evidence as (typeof EVIDENCE)[number] } : {}),
      ...(androidVersions.length ? { androidVersions } : {}),
      ...(options.video === false ? { video: false } : {}),
      ...(options.accessibility ? { accessibility: "warn" as const } : {}),
      ...(options.recordNetwork
        ? { network: "record" as const }
        : options.liveNetwork
          ? { network: "live" as const }
          : {}),
      ...(io.signal ? { signal: io.signal } : {}),
      trigger: io.env.CI ? "ci" : "cli",
      onEvent,
    });
  } catch (error) {
    io.stdout(
      `The run could not finish: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const run = result.run;
  const { formatRunSummary, formatTestLine } = await import("@optestra/report");
  const color = io.color ?? false;
  io.stdout("\n");
  // A matrix run (TGT-5): each line names its browser and device.
  const matrix =
    new Set(result.tests.map((t) => JSON.stringify(t.matrix))).size > 1 ||
    browsers.length > 1 ||
    devices.length > 1;
  for (const test of result.tests) {
    const where =
      matrix && test.matrix.target === "web"
        ? ` [${test.matrix.browser}, ${test.matrix.device ?? "default"}]`
        : "";
    io.stdout(
      `${formatTestLine({ ...test, name: `${test.name}${where}`, aiCalls: test.ai.calls, costUsd: test.ai.costUsd }, { color })}\n`,
    );
    if (test.failureCause && test.verdict !== "blocked" && test.verdict !== "passed")
      io.stdout(`${" ".repeat(49)}cause: ${test.failureCause.replace("_", " ")}\n`);
    if (
      test.ai.calls > 0 &&
      test.attempts.every((a) => a.modelCalls.every((c) => c.billing === "subscription"))
    )
      io.stdout(`${" ".repeat(49)}AI via your subscription\n`);
  }
  const pendingHeals = result.tests.reduce(
    (n, t) => n + (t.attempts.at(-1)?.heals.filter((h) => h.status === "pending").length ?? 0),
    0,
  );
  if (pendingHeals > 0)
    io.stdout(
      `\n${pendingHeals} heal${pendingHeals === 1 ? "" : "s"} to review: ${brand.cliName} heal ${posix(relative(io.cwd, result.dir))}\n`,
    );
  for (const entry of result.recorded)
    io.stdout(
      `\nRecorded: ${entry.recording}${entry.specs.length ? ` (spec: ${entry.specs.join(", ")})` : ""}${entry.warnings.map((w) => `\n  warning: ${w}`).join("")}`,
    );
  if (result.recorded.length) io.stdout("\n");
  const loaded = loadProject(dir, { environment: options.env, env });
  const exitCode = exitCodeFor(run, {
    healedCountsAsPass: loaded.config.run.healPolicy === "auto",
  });
  const where = posix(relative(io.cwd, result.dir));
  io.stdout(
    `\n${formatRunSummary({ run, tests: result.tests }, { color })}\n  Results: ${where} (${brand.cliName} results ${where}, ${brand.cliName} report ${where})\n  exit code ${exitCode}\n`,
  );
  return exitCode;
}

/** `run --cloud` (CLI-2, CLOUD-2): the same selection and output, run in the hosted cloud. */
async function cloudRun(
  dir: string,
  tests: string[],
  options: RunCommandOptions,
  viewport: { width: number; height: number } | undefined,
  io: CommandIo & { color?: boolean; signal?: AbortSignal },
): Promise<number> {
  const { loadProject } = await import("@optestra/config/node");
  const { loadTests } = await import("@optestra/spec/node");
  const { exitCodeFor, foldEvents } = await import("@optestra/contract");
  const { formatRunSummary } = await import("@optestra/report");
  const { runInCloud } = await import("./cloud.js");
  const loaded = loadProject(dir, { environment: options.env, env: io.env });
  const all = await loadTests(dir, loaded.config, { environment: options.env });
  // The same selection as a local run: files or folders, tags, name.
  const wanted = tests.map((t) => posix(relative(dir, resolve(io.cwd, t))));
  const selected = all.tests
    .filter(
      (t) =>
        wanted.length === 0 ||
        wanted.some((w) => t.path === w || t.path.startsWith(`${w.replace(/\/+$/, "")}/`)),
    )
    .filter(
      (t) =>
        !options.tag?.length || t.spec.frontmatter.tags.some((tag) => options.tag?.includes(tag)),
    )
    .filter(
      (t) =>
        !options.grep || t.spec.frontmatter.name.toLowerCase().includes(options.grep.toLowerCase()),
    )
    .map((t) => t.path);
  if (selected.length === 0) {
    io.stdout("No tests match.\n");
    return 2;
  }
  const names = new Map<string, string>();
  const browsers = list(options.browser);
  const devices = list(options.device);
  return runInCloud(
    dir,
    loaded.config.project?.name ?? "project",
    selected,
    loaded.config.run.healPolicy === "auto",
    {
      ...(options.cloudUrl ? { cloudUrl: options.cloudUrl } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.replayOnly ? { replayOnly: true } : {}),
      ...(options.rerecord ? { rerecord: true } : {}),
      ...(browsers.length ? { browser: browsers } : {}),
      ...(devices.length ? { device: devices } : {}),
      ...(options.locale ? { locale: options.locale } : {}),
      ...(options.timezone ? { timezone: options.timezone } : {}),
      ...(options.evidence ? { evidence: options.evidence } : {}),
      ...(viewport ? { viewport } : {}),
    },
    io,
    {
      onEvent: (event) => {
        if (event.type === "run.started")
          io.stdout(
            `Running ${event.project}${event.environment ? ` on ${event.environment}` : ""} (${event.mode}, in the cloud)\n`,
          );
        if (event.type === "test.started") names.set(event.testId, event.name);
        if (event.type === "test.finished")
          io.stdout(`  ${event.verdict.padEnd(7)} ${names.get(event.testId) ?? event.testId}\n`);
        if (options.verbose && event.type === "log" && event.level !== "debug")
          io.stdout(`  ${event.message}\n`);
      },
      summary: (events) => {
        let folded: ReturnType<typeof foldEvents>;
        try {
          folded = foldEvents(events);
        } catch {
          io.stdout("\nThe run's events were incomplete.\n  exit code 2\n");
          return 2;
        }
        const code = exitCodeFor(folded.run, {
          healedCountsAsPass: loaded.config.run.healPolicy === "auto",
        });
        io.stdout(
          `\n${formatRunSummary({ run: folded.run, tests: folded.tests }, { color: io.color ?? false })}\n  exit code ${code}\n`,
        );
        return code;
      },
    },
  );
}
