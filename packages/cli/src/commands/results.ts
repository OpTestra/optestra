import { resolve } from "node:path";
import {
  exitCodeFor,
  formatDuration,
  formatUsd,
  type Run,
  summarize,
  type Verdict,
} from "@testament/contract";
import { readRun } from "@testament/contract/node";
import type { CommandIo } from "./config.js";

export interface ResultsCommandOptions {
  json?: boolean;
  /** Healed tests count as passed for the exit code. */
  healedPasses?: boolean;
  /** Flaky tests don't fail the exit code. */
  flakyPasses?: boolean;
}

const LABEL: Record<Verdict, string> = {
  passed: "PASSED",
  healed: "HEALED",
  failed: "FAILED",
  flaky: "FLAKY",
  blocked: "BLOCKED",
};

function human(run: Run, exitCode: number): string {
  const summary = summarize(run);
  const where = [run.project, run.environment, run.target].filter(Boolean).join(" · ");
  const lines = [`Run ${run.runId}  ${where}`, ""];
  if (run.blocked) lines.push(`  Run blocked (${run.blocked.reason}): ${run.blocked.message}`, "");
  for (const test of run.tests) {
    lines.push(
      `  ${LABEL[test.verdict].padEnd(8)} ${formatDuration(test.durationMs).padStart(7)}  ${formatUsd(test.costUsd).padStart(8)}  ${test.name}`,
    );
    if (test.headline) lines.push(`${" ".repeat(29)}${test.headline}`);
  }
  const ai = `${summary.aiCalls} AI call${summary.aiCalls === 1 ? "" : "s"}`;
  const unpriced = summary.unpricedCalls > 0 ? ` (${summary.unpricedCalls} unpriced)` : "";
  lines.push(
    "",
    `  ${summary.line} · ${formatDuration(summary.durationMs)} · ${formatUsd(summary.costUsd)} · ${ai}${unpriced}`,
    `  exit code ${exitCode}`,
  );
  return lines.join("\n");
}

/**
 * `results <runDir>`: prints a run's summary and returns the CI exit code
 * (0 passed, 1 failures, 2 blocked or unreadable).
 */
export function runResultsCommand(
  runDir: string,
  options: ResultsCommandOptions,
  io: CommandIo,
): number {
  const { run, diagnostics } = readRun(resolve(io.cwd, runDir));
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
  const exitCode = exitCodeFor(run, {
    healedCountsAsPass: options.healedPasses ?? false,
    flakyCountsAsFailure: !options.flakyPasses,
  });
  io.stdout(
    options.json
      ? `${JSON.stringify({ summary: summarize(run), exitCode, run }, null, 2)}\n`
      : `${human(run, exitCode)}\n`,
  );
  return exitCode;
}
