// First, so the project-file sections register in their usual order.
import "./sections.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { Command } from "commander";
import { registerAndroidCommands } from "./commands/android.js";
import { registerAuthCommands } from "./commands/auth.js";
import type { AuthorCommandOptions } from "./commands/author.js";
import { registerBrowserCommands } from "./commands/browser.js";
import type { ChecksCommandOptions } from "./commands/checks.js";
import type { ConfigCommandOptions } from "./commands/config.js";
import type { DeciderSetupOptions } from "./commands/decider.js";
import type { DecisionsCommandOptions } from "./commands/decisions.js";
import type { DoctorCommandOptions } from "./commands/doctor.js";
import type { ExplainCommandOptions } from "./commands/explain.js";
import type { ExploreCommandOptions } from "./commands/explore.js";
import { registerExportCommand } from "./commands/export.js";
import type { GenerateCommandOptions } from "./commands/generate.js";
import type { HealCommandOptions } from "./commands/heal.js";
import { registerInitCommand } from "./commands/init.js";
import type { LintCommandOptions } from "./commands/lint.js";
import type { McpCommandOptions } from "./commands/mcp.js";
import type { MergeRunsCommandOptions } from "./commands/merge-runs.js";
import type { ModelsCommandOptions } from "./commands/models.js";
import type { NewCommandOptions } from "./commands/new.js";
import type { RecordCommandOptions } from "./commands/record.js";
import type { ReportCommandOptions } from "./commands/report.js";
import type { ResultsCommandOptions } from "./commands/results.js";
import type { RunCommandOptions } from "./commands/run.js";
import type { ListCommandOptions, ShowCommandOptions } from "./commands/tests.js";

// Startup stays light: every command loads its implementation inside its action,
// so `--help` or `config` never loads Playwright, the AI SDK or the decision
// backends. Only light modules (options, the project-file sections) load here.

/** The engine version, read without loading the engine. */
function engineVersion(): string {
  const entry = fileURLToPath(import.meta.resolve("@testament/core"));
  const pkg = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
  return (pkg as { version: string }).version;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** Commander collector for a repeatable option. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function createProgram(): Command {
  const program = new Command()
    .name(brand.cliName)
    .description(
      `${brand.productName}: test websites and Android apps from plain-English descriptions.`,
    )
    .version(engineVersion(), "-v, --version", "print the engine version")
    .helpOption("-h, --help", "show this help");

  program
    .command("config")
    .description("show the resolved project settings for an environment and where each came from")
    .option("-e, --env <name>", "environment to resolve")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ConfigCommandOptions) => {
      const { runConfigCommand } = await import("./commands/config.js");
      process.exitCode = runConfigCommand(options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  program
    .command("models")
    .description("show each AI role's provider pool, key status and usage caps")
    .option("-e, --env <name>", "environment to resolve")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--check", "check every provider's API key with the cheapest possible call")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ModelsCommandOptions) => {
      const { runModelsCommand } = await import("./commands/models.js");
      process.exitCode = await runModelsCommand(options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  program
    .command("decisions")
    .description(
      "show the decision routing, thresholds and tasks; --check the backends, --bench their speed, --eval their accuracy, --stats a run's decisions",
    )
    .option("--check", "check every decision backend: key valid, reachable, model installed")
    .option("--bench", "measure decision latency on the demo task (after a warm-up)")
    .option("--eval", "score the decisions on the committed eval sets (exit 1 on a false label)")
    .option(
      "--backend <name>",
      "for --bench: jev, kev, laya or all (default: the selected backend); for --eval: rules (default), jev, kev or laya",
    )
    .option("--n <count>", "for --bench: decisions per backend", "50")
    .option("--model-only", "for --eval with a backend: rules off, to measure the model alone")
    .option("--stats <runDir>", "print per-task decision metrics from a run folder")
    .option("-e, --env <name>", "environment to resolve")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--json", "print machine-readable JSON")
    .action(async (options: DecisionsCommandOptions) => {
      const { runDecisionsCommand } = await import("./commands/decisions.js");
      process.exitCode = await runDecisionsCommand(options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  program
    .command("decider")
    .description("set up a decision model backend")
    .command("setup")
    .description(
      "laya: find the local Ollaya and, if you agree, download the model (never installs Ollaya); jev/kev: how to set them up",
    )
    .argument("<backend>", "laya, jev or kev")
    .option("--model <name>", "the Laya model (default: decisions.laya.model)")
    .option("-y, --yes", "download without asking")
    .option("-e, --env <name>", "environment to resolve")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (backend: string, options: DeciderSetupOptions) => {
      const { runDeciderSetup } = await import("./commands/decider.js");
      process.exitCode = await runDeciderSetup(backend, options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
        ...(process.stdin.isTTY ? { confirm: askYesNo } : {}),
      });
    });

  program
    .command("results")
    .description(
      "summarise a finished run folder and exit with its CI code (0 passed, 1 failed, 2 blocked)",
    )
    .argument("<runDir>", "the run folder (contains run.json)")
    .option("--json [file]", "print the machine-readable JSON summary, or write it to <file>")
    .option("--junit <file>", "also write JUnit XML to <file>")
    .option(
      "--markdown <file>",
      "also write the Markdown summary (PR comment, job summary) to <file>",
    )
    .option("--report-url <url>", "link the Markdown summary to the full report at this URL")
    .option("--healed-passes", "count healed tests as passed (default: they fail the exit code)")
    .option("--flaky-passes", "do not fail the exit code for flaky tests")
    .action(async (runDir: string, options: ResultsCommandOptions) => {
      const { shouldUseColor } = await import("@testament/report/node");
      const { runResultsCommand } = await import("./commands/results.js");
      process.exitCode = runResultsCommand(runDir, options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
        color: shouldUseColor(process.stdout),
      });
    });

  program
    .command("merge-runs")
    .description(
      "merge shard run folders (run --shard i/n) into one run folder, then summarise it like run",
    )
    .argument("<dirs...>", "run folders, or folders that contain them (searched two levels)")
    .requiredOption("--out <dir>", "the merged run folder to create")
    .option("--healed-passes", "count healed tests as passed (default: the project's heal policy)")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (dirs: string[], options: MergeRunsCommandOptions) => {
      const { runMergeRunsCommand } = await import("./commands/merge-runs.js");
      const { shouldUseColor } = await import("@testament/report/node");
      process.exitCode = await runMergeRunsCommand(dirs, options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
        color: shouldUseColor(process.stdout),
      });
    });

  program
    .command("report")
    .description("write the offline HTML report of a run (default: the project's latest run)")
    .argument("[runDir]", "the run folder (contains run.json)")
    .option("--out <dir>", "write index.html here instead of into the run folder")
    .option("--open", "open the report in the default browser")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (runDir: string | undefined, options: ReportCommandOptions) => {
      const { runReportCommand } = await import("./commands/report.js");
      process.exitCode = runReportCommand(runDir, options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  program
    .command("list")
    .description("list the project's runnable tests with their step and problem counts")
    .option("-t, --tag <tag>", "only tests with this tag")
    .option("-e, --env <name>", "environment whose overrides and vars apply")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--json", "print machine-readable JSON")
    .action(async (options: ListCommandOptions) => {
      const { runListCommand } = await import("./commands/tests.js");
      process.exitCode = await runListCommand(options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  program
    .command("show")
    .description("show one test file as the engine reads it (exit 2 when it has errors)")
    .argument("<file>", "the .test.md file")
    .option("--expanded", "inline flows and bind variables (secrets stay {{secret.NAME}})")
    .option("-e, --env <name>", "environment whose overrides and vars apply")
    .option("--seed <seed>", "seed for generated values like {{unique.email}}", "preview")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--json", "print machine-readable JSON")
    .action(async (file: string, options: ShowCommandOptions) => {
      const { runShowCommand } = await import("./commands/tests.js");
      process.exitCode = await runShowCommand(file, options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  program
    .command("lint")
    .description(
      "check test files for problems and weak tests (exit 1 on errors, 2 if a file can't be parsed)",
    )
    .argument("[paths...]", "test files or folders (default: every test and flow in the project)")
    .option("--fix", "apply the safe fixes (never changes an Expect:, Soft: or Never: line)")
    .option("--strict", "count warnings as errors")
    .option("-e, --env <name>", "environment whose overrides and vars apply")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--json", "print machine-readable JSON")
    .action(async (paths: string[], options: LintCommandOptions) => {
      const { runLintCommand } = await import("./commands/lint.js");
      process.exitCode = await runLintCommand(paths, options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  program
    .command("author")
    .description(
      "let the AI carry out a test's steps once and save the recording that later runs replay",
    )
    .argument("<file>", "the .test.md file")
    .option("-e, --env <name>", "environment to run against")
    .option("--headed", "show the browser or emulator window")
    .option(
      "--device <preset>",
      "device preset, e.g. desktop, laptop, iphone-15 (Android: a device profile, e.g. pixel-8)",
    )
    .option("--browser <name>", "chromium (default), firefox or webkit")
    .option(
      "--android <version>",
      "Android projects: the Android version (default: android.version)",
    )
    .option("--video", "also record a video")
    .option("-C, --dir <path>", "project folder (default: the test's nearest project)")
    .action(async (file: string, options: AuthorCommandOptions) => {
      const { runAuthorCommand } = await import("./commands/author.js");
      process.exitCode = await runAuthorCommand(file, options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  program
    .command("new")
    .description(
      "draft a test from one sentence by exploring the app (AI); prints it, and saves it only with --accept or --out",
    )
    .argument("<sentence>", 'what the test should show, e.g. "a returning user can log in"')
    .option("--accept", "save the draft in the tests folder (only when lint is clean)")
    .option("--out <file>", "write the draft to this file instead (never over an existing file)")
    .option("--start <path>", "where the test starts, e.g. /login (default /)")
    .option("-e, --env <name>", "environment to explore")
    .option("--headed", "show the browser window")
    .option("--json", "print machine-readable JSON (never asks)")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (sentence: string, options: NewCommandOptions) => {
      const { runNewCommand } = await import("./commands/new.js");
      const interactive = process.stdin.isTTY && process.stdout.isTTY && !options.json;
      process.exitCode = await runNewCommand(sentence, options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
        ...(interactive ? { confirm: askYesNo } : {}),
      });
    });

  program
    .command("record")
    .description(
      "record a test by clicking through the app in a browser window; mark expectations with the overlay. Saves it (and its recording) only when you say so",
    )
    .option("--url <url>", "where to start: a path on the app (/login) or a URL")
    .option("--name <name>", "the test's name")
    .option("--accept", "save it in the tests folder without asking")
    .option("--out <file>", "save it to this file instead (never over an existing file)")
    .option("--browser <name>", "chromium (default), firefox or webkit")
    .option("-e, --env <name>", "environment to record on")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (options: RecordCommandOptions) => {
      const { runRecordCommand } = await import("./commands/record.js");
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      try {
        process.exitCode = await runRecordCommand(options, {
          cwd: process.cwd(),
          env: process.env,
          stdout: (text) => process.stdout.write(text),
          signal: controller.signal,
          ...(process.stdin.isTTY && process.stdout.isTTY ? { confirm: askYesNo } : {}),
        });
      } finally {
        process.off("SIGINT", stop);
      }
    });

  program
    .command("explore")
    .description(
      "explore the app toward a goal (AI) and report errors, failed requests, console errors, broken links and dead ends, with proposed tests. Never fails a run",
    )
    .argument("[url]", "where to start (default: the environment's baseUrl)")
    .requiredOption("--goal <goal>", 'what to head for, e.g. "a visitor buys the Pro plan"')
    .option("--start <path>", "where to start on the app (default /)")
    .option("--links <n>", "same-site links to check for broken ones (default 25)")
    .option("--save-drafts <folder>", "write the proposed tests there (never into your tests)")
    .option("--headed", "show the browser window")
    .option("--json", "print machine-readable JSON")
    .option("-e, --env <name>", "environment to explore")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (url: string | undefined, options: ExploreCommandOptions) => {
      const { runExploreCommand } = await import("./commands/explore.js");
      process.exitCode = await runExploreCommand(url, options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  program
    .command("mcp")
    .description(
      "start the MCP server for coding agents (stdio) on this project: list, draft, save and run tests, read results, accept heals",
    )
    .option("-e, --env <name>", "default environment for runs and drafts")
    .option("--headed", "show the browser windows")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (options: McpCommandOptions) => {
      const { runMcpCommand } = await import("./commands/mcp.js");
      process.exitCode = await runMcpCommand(options, {
        cwd: process.cwd(),
        env: process.env,
        stderr: (text) => process.stderr.write(text),
      });
    });

  program
    .command("run")
    .description(
      "run tests: replay each recording with no AI, evaluate every check, write a results folder (exit 0 passed, 1 failed, 2 blocked)",
    )
    .argument("[tests...]", "test files or folders (default: every test)")
    .option("-t, --tag <tag...>", "only tests with this tag (repeatable)")
    .option("--grep <text>", "only tests whose name contains this")
    .option("--shard <i/n>", "run only slice i of n (split by test id; merge with merge-runs)")
    .option("-e, --env <name>", "environment to run against")
    .option("--base-url <url>", "run against this URL (e.g. a preview deploy) instead of baseUrl")
    .option("--replay-only", "no AI at all: a missed or unrecorded step fails (strict CI)")
    .option("--rerecord", "ignore the recordings and record every step again with AI")
    .option("--retries <n>", "extra attempts after a failure (default: run.retries)")
    .option("--workers <n>", "tests in parallel, one browser or emulator each (default 1)")
    .option(
      "--budget <usd>",
      "AI budget for this run in dollars (default: run.budget.maxPerRunUsd)",
    )
    .option("--headed", "show the browser or emulator windows")
    .option(
      "--browser <name>",
      "chromium (default), firefox or webkit; repeat for a matrix (one result per browser × device)",
      collect,
      [],
    )
    .option(
      "--device <preset>",
      "device preset, e.g. desktop, laptop, iphone-15 (Android: a device profile, e.g. pixel-8); repeat for a matrix",
      collect,
      [],
    )
    .option("--locale <code>", "browser locale, or the Android app's language, e.g. de-DE")
    .option("--timezone <id>", "browser or device timezone, e.g. Europe/Berlin")
    .option(
      "--evidence <mode>",
      "full | failures | minimal (default: run.evidence, else full in CI and failures elsewhere)",
    )
    .option(
      "--android <version>",
      "Android projects: the Android version (default: android.version); repeat for a matrix",
      collect,
      [],
    )
    .option("--no-video", "don't record a video per attempt")
    .option("--verbose", "print every step, heal and warning")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (tests: string[], options: RunCommandOptions) => {
      const { shouldUseColor } = await import("@testament/report/node");
      const { runRunCommand } = await import("./commands/run.js");
      // Ctrl-C stops the run cleanly (the running test's evidence is kept); a second one quits.
      const stop = new AbortController();
      const onInterrupt = () => {
        if (stop.signal.aborted) process.exit(130);
        process.stdout.write("\nStopping after the current step (Ctrl-C again to quit now)…\n");
        stop.abort();
      };
      process.on("SIGINT", onInterrupt);
      try {
        process.exitCode = await runRunCommand(tests, options, {
          cwd: process.cwd(),
          env: process.env,
          stdout: (text) => process.stdout.write(text),
          color: shouldUseColor(process.stdout),
          signal: stop.signal,
        });
      } finally {
        process.off("SIGINT", onInterrupt);
      }
    });

  program
    .command("explain")
    .description(
      "explain why tests failed, from the run's evidence (rules only; --ai: one AI call). Never changes a verdict",
    )
    .argument("[runDir]", "the run folder (default: the project's latest run)")
    .argument("[test]", "a test id, file or name part (default: every test that didn't pass)")
    .option("--ai", "let the AI write the diagnosis from the same evidence (one model call)")
    .option("--json", "print machine-readable JSON")
    .option("-e, --env <name>", "environment (for the AI settings)")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(
      async (
        runDir: string | undefined,
        test: string | undefined,
        options: ExplainCommandOptions,
      ) => {
        const { runExplainCommand } = await import("./commands/explain.js");
        process.exitCode = await runExplainCommand(
          [runDir, test].filter((a): a is string => a !== undefined),
          options,
          { cwd: process.cwd(), env: process.env, stdout: (text) => process.stdout.write(text) },
        );
      },
    );

  program
    .command("heal")
    .description(
      "review a run's heals (default: the latest run): the recording diff, why, confidence; accept or reject them",
    )
    .argument("[runDir]", "the run folder (contains run.json)")
    .option("--list", "only list the heals (the default without --accept/--reject)")
    .option("--accept <ids...>", "apply these heals to the recording (heal ids, or all)")
    .option("--reject <ids...>", "reject these heals (the recording stays as it is)")
    .option("--json", "print machine-readable JSON")
    .option("-e, --env <name>", "environment for regenerating the portable spec")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (runDir: string | undefined, options: HealCommandOptions) => {
      const { runHealCommand } = await import("./commands/heal.js");
      process.exitCode = await runHealCommand(runDir, options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  program
    .command("checks")
    .description(
      "show what each Expect line of a test was compiled into: the check, how it was made, its sanity test",
    )
    .argument("<file>", "the .test.md file")
    .option("--json", "print JSON")
    .option("-e, --env <name>", "environment (for the project settings)")
    .option("-C, --dir <path>", "project folder (default: the test's nearest project)")
    .action(async (file: string, options: ChecksCommandOptions) => {
      const { runChecksCommand } = await import("./commands/checks.js");
      process.exitCode = await runChecksCommand(file, options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  registerAuthCommands(program, () => ({
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
  }));

  program
    .command("login")
    .description(
      "show which AI subscription tools (Claude Code, Codex) are ready, and how to sign in to them",
    )
    .action(async () => {
      const { runLoginCommand } = await import("./commands/login.js");
      process.exitCode = await runLoginCommand({
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  program
    .command("generate")
    .description(
      "write the plain Playwright spec of each recorded test next to its recording (runs without this tool)",
    )
    .argument("[tests...]", "test files or folders (default: every recorded test)")
    .option("--force", "overwrite generated files that were changed by hand")
    .option("--check", "write nothing; exit 1 if a spec is out of date or changed by hand (for CI)")
    .option("-e, --env <name>", "environment whose base URL and allowed domains the specs use")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (tests: string[], options: GenerateCommandOptions) => {
      const { runGenerateCommand } = await import("./commands/generate.js");
      process.exitCode = await runGenerateCommand(tests, options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
      });
    });

  registerBrowserCommands(program, () => ({
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
  }));

  const io = () => ({
    cwd: process.cwd(),
    env: process.env,
    stdout: (text: string) => process.stdout.write(text),
  });
  registerInitCommand(program, io);
  program
    .command("doctor")
    .description(
      "check the project, tests, secrets, AI setup, browsers and recordings; every problem comes with its fix",
    )
    .option("-e, --env <name>", "check only this environment (default: all)")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--strict", "exit 1 when there are warnings")
    .option("--json", "print machine-readable JSON")
    .action(async (options: DoctorCommandOptions) => {
      const { runDoctorCommand } = await import("./commands/doctor.js");
      process.exitCode = await runDoctorCommand(options, io());
    });
  registerExportCommand(program, io);
  registerAndroidCommands(program, () => ({
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    ...(process.stdin.isTTY ? { confirm: askYesNo } : {}),
  }));

  program.action(() => program.help());
  return program;
}
