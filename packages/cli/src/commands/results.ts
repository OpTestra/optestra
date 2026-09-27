import { relative, resolve } from "node:path";
import { type ExitPolicy, exitCodeFor, withHealReview } from "@testament/contract";
import { readHealReview, readRun } from "@testament/contract/node";
import {
  formatTerminal,
  type RunData,
  renderJsonSummary,
  renderJunit,
  renderMarkdownSummary,
} from "@testament/report";
import { writeFileAtomic } from "@testament/report/node";
import type { CommandIo } from "./config.js";

export interface ResultsCommandOptions {
  /** true: print the JSON summary; a path: write it there. */
  json?: boolean | string;
  /** Write JUnit XML here (EVD-4). */
  junit?: string;
  /** Write the Markdown summary here (CI-2, CI-5). */
  markdown?: string;
  /** Link the Markdown summary's footer to the full report (e.g. `artifact:index.html`). */
  reportUrl?: string;
  /** Healed tests count as passed for the exit code. */
  healedPasses?: boolean;
  /** Flaky tests don't fail the exit code. */
  flakyPasses?: boolean;
}

function writeExports(
  data: RunData,
  options: ResultsCommandOptions,
  policy: ExitPolicy,
  io: CommandIo,
): string[] {
  const files: [string | undefined, () => string][] = [
    [options.junit, () => renderJunit(data)],
    [
      typeof options.json === "string" ? options.json : undefined,
      () => renderJsonSummary(data, policy),
    ],
    [
      options.markdown,
      () => renderMarkdownSummary(data, options.reportUrl ? { reportUrl: options.reportUrl } : {}),
    ],
  ];
  const written: string[] = [];
  for (const [file, render] of files) {
    if (!file) continue;
    const path = resolve(io.cwd, file);
    writeFileAtomic(path, render());
    const shown = relative(io.cwd, path);
    written.push(shown.startsWith("..") ? path : shown);
  }
  return written;
}

/**
 * `results <runDir>`: prints a run's summary, writes any requested exports
 * (--junit, --json <file>, --markdown) and returns the CI exit code
 * (0 passed, 1 failures, 2 blocked or unreadable).
 */
export function runResultsCommand(
  runDir: string,
  options: ResultsCommandOptions,
  io: CommandIo & { color?: boolean },
): number {
  const { run, tests: read, diagnostics } = readRun(resolve(io.cwd, runDir));
  const review = readHealReview(resolve(io.cwd, runDir));
  const tests = read.map((test) => withHealReview(test, review));
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (!run || errors.length > 0) {
    const problems = errors.map((d) => `  ${d.file}${d.line ? `:${d.line}` : ""}  ${d.message}`);
    io.stdout(
      options.json
        ? `${JSON.stringify({ error: "unreadable run", diagnostics: errors }, null, 2)}\n`
        : `Cannot read the run in ${runDir}:\n${problems.join("\n")}\n`,
    );
    return 2;
  }
  const policy: ExitPolicy = {
    healedCountsAsPass: options.healedPasses ?? false,
    flakyCountsAsFailure: !options.flakyPasses,
  };
  const exitCode = exitCodeFor(run, policy);
  const data: RunData = { run, tests };
  const written = writeExports(data, options, policy, io);
  if (options.json === true) {
    io.stdout(renderJsonSummary(data, policy));
    return exitCode;
  }
  const wrote = written.map((file) => `  wrote ${file}\n`).join("");
  io.stdout(
    `${formatTerminal(data, { color: io.color ?? false })}\n  exit code ${exitCode}\n${wrote}`,
  );
  return exitCode;
}
