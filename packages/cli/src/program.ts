import { createInterface } from "node:readline/promises";
import { brand } from "@testament/brand";
import { version } from "@testament/core";
import { Command } from "commander";
import { registerAndroidCommands } from "./commands/android.js";
import { registerAuthCommands } from "./commands/auth.js";
import { type AuthorCommandOptions, runAuthorCommand } from "./commands/author.js";
import { registerBrowserCommands } from "./commands/browser.js";
import { type ChecksCommandOptions, runChecksCommand } from "./commands/checks.js";
import { type ConfigCommandOptions, runConfigCommand } from "./commands/config.js";
import { type DeciderSetupOptions, runDeciderSetup } from "./commands/decider.js";
import { type DecisionsCommandOptions, runDecisionsCommand } from "./commands/decisions.js";
import { type GenerateCommandOptions, runGenerateCommand } from "./commands/generate.js";
import { type LintCommandOptions, runLintCommand } from "./commands/lint.js";
import { runLoginCommand } from "./commands/login.js";
import { type ModelsCommandOptions, runModelsCommand } from "./commands/models.js";
import { type ResultsCommandOptions, runResultsCommand } from "./commands/results.js";
import {
  type ListCommandOptions,
  runListCommand,
  runShowCommand,
  type ShowCommandOptions,
} from "./commands/tests.js";

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export function createProgram(): Command {
  const program = new Command()
    .name(brand.cliName)
    .description(
      `${brand.productName}: test websites and Android apps from plain-English descriptions.`,
    )
    .version(version(), "-v, --version", "print the engine version")
    .helpOption("-h, --help", "show this help");

  program
    .command("config")
    .description("show the resolved project settings for an environment and where each came from")
    .option("-e, --env <name>", "environment to resolve")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--json", "print machine-readable JSON")
    .action((options: ConfigCommandOptions) => {
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
    .option("--json", "print machine-readable JSON")
    .option("--healed-passes", "count healed tests as passed (default: they fail the exit code)")
    .option("--flaky-passes", "do not fail the exit code for flaky tests")
    .action((runDir: string, options: ResultsCommandOptions) => {
      process.exitCode = runResultsCommand(runDir, options, {
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
    .option("--headed", "show the browser window")
    .option("--device <preset>", "device preset, e.g. desktop, laptop, iphone-15")
    .option("--browser <name>", "chromium (default), firefox or webkit")
    .option("--video", "also record a video")
    .option("-C, --dir <path>", "project folder (default: the test's nearest project)")
    .action(async (file: string, options: AuthorCommandOptions) => {
      process.exitCode = await runAuthorCommand(file, options, {
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

  registerAndroidCommands(program, () => ({
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    ...(process.stdin.isTTY ? { confirm: askYesNo } : {}),
  }));

  program.action(() => program.help());
  return program;
}
