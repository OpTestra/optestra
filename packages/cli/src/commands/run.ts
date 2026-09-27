import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { brand } from "@testament/brand";
import { findProject, projectFile } from "@testament/config/node";
import type { Event, RunMode } from "@testament/contract";
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
  browser?: string;
  device?: string;
  video?: boolean;
  verbose?: boolean;
  dir?: string;
}

const posix = (path: string) => path.split(sep).join("/");

function parseCount(value: string | undefined, what: string): number | undefined | string {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : `--${what} must be a whole number, not "${value}".`;
}

export async function runRunCommand(
  tests: string[],
  options: RunCommandOptions,
  io: CommandIo & { color?: boolean },
): Promise<number> {
  const dir = options.dir
    ? resolve(io.cwd, options.dir)
    : (findProject(tests[0] ? resolve(io.cwd, tests[0]) : io.cwd) ?? io.cwd);
  if (!existsSync(projectFile(dir))) {
    io.stdout(`No project file found in ${dir}. Create one first (${brand.cliName} init).\n`);
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
  if (budget !== undefined && !(budget >= 0)) {
    io.stdout(`--budget must be an amount in dollars, like 0.50, not "${options.budget}".\n`);
    return 2;
  }
  const mode: RunMode | undefined = options.replayOnly
    ? "replay-only"
    : options.rerecord
      ? "rerecord"
      : undefined;

  const { parseShard, runTests } = await import("@testament/core/node");
  const shard = options.shard === undefined ? undefined : parseShard(options.shard);
  if (typeof shard === "string") {
    io.stdout(`${shard}\n`);
    return 2;
  }
  const { exitCodeFor, formatDuration } = await import("@testament/contract");
  const { loadProject } = await import("@testament/config/node");
  const { ENV_PREFIX } = await import("@testament/config");
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
        `    ${String(step.index + 1).padStart(2)}. ${step.text.slice(0, 64).padEnd(64)} ${step.status}${how} ${formatDuration(step.durationMs)}\n`,
      );
      if (step.error) io.stdout(`        ${step.error}\n`);
    }
    if (event.type === "heal.proposed")
      io.stdout(
        `        healed without AI: ${event.heal.changes.map((c) => `${c.before} → ${c.after}`).join("; ")} (${event.heal.classification}, pending review)\n`,
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
      ...(options.browser ? { browser: options.browser as "chromium" | "firefox" | "webkit" } : {}),
      ...(options.device ? { device: options.device } : {}),
      ...(options.video === false ? { video: false } : {}),
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
  const { formatRunSummary, formatTestLine } = await import("@testament/report");
  const color = io.color ?? false;
  io.stdout("\n");
  for (const test of result.tests) {
    io.stdout(
      `${formatTestLine({ ...test, aiCalls: test.ai.calls, costUsd: test.ai.costUsd }, { color })}\n`,
    );
    if (test.failureCause && test.verdict !== "blocked" && test.verdict !== "passed")
      io.stdout(`${" ".repeat(49)}cause: ${test.failureCause.replace("_", " ")}\n`);
    if (
      test.ai.calls > 0 &&
      test.attempts.every((a) => a.modelCalls.every((c) => c.billing === "subscription"))
    )
      io.stdout(`${" ".repeat(49)}AI via your subscription\n`);
  }
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
