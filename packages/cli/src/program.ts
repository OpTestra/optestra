import { brand } from "@testament/brand";
import { version } from "@testament/core";
import { Command } from "commander";
import { type ConfigCommandOptions, runConfigCommand } from "./commands/config.js";
import { type DecisionsCommandOptions, runDecisionsCommand } from "./commands/decisions.js";
import { type LintCommandOptions, runLintCommand } from "./commands/lint.js";
import { type ModelsCommandOptions, runModelsCommand } from "./commands/models.js";
import { type ResultsCommandOptions, runResultsCommand } from "./commands/results.js";
import {
  type ListCommandOptions,
  runListCommand,
  runShowCommand,
  type ShowCommandOptions,
} from "./commands/tests.js";

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
      "show the decision backend, thresholds and tasks; --stats reads a run folder's decisions",
    )
    .option("--stats <runDir>", "print per-task decision metrics from a run folder")
    .option("-e, --env <name>", "environment to resolve")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--json", "print machine-readable JSON")
    .action((options: DecisionsCommandOptions) => {
      process.exitCode = runDecisionsCommand(options, {
        cwd: process.cwd(),
        env: process.env,
        stdout: (text) => process.stdout.write(text),
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

  program.action(() => program.help());
  return program;
}
