import { formatDuration, formatUsd, stepLabel, summarize, type Verdict } from "@optestra/contract";
import { buildModel, CAUSE_LABEL, costText, plural, type RunData, words } from "./model.js";

// Quiet terminal output (CLI-4): one line per test, then a summary and the
// failure groups. Plain text unless `color` is on; colour only ever repeats
// what the words already say.

export interface TerminalOptions {
  /** ANSI colour. Use `shouldUseColor` from the node entry to decide. */
  color?: boolean;
}

/** What a test line needs: a RunTestRef has it, and so does a live test result. */
export interface TestLineInput {
  name: string;
  verdict: Verdict;
  durationMs: number;
  aiCalls: number;
  costUsd: number;
  headline?: string | null;
  /** DIA-5: muted (a RunTestRef's flag, or a TestResult's mute): shown as MUTED, doesn't count. */
  muted?: boolean | { until: string; reason: string } | undefined;
}

const LABEL: Record<Verdict, string> = {
  passed: "PASSED",
  healed: "HEALED",
  failed: "FAILED",
  flaky: "FLAKY",
  blocked: "BLOCKED",
};

const COLOR: Record<Verdict, number> = {
  passed: 32,
  healed: 36,
  failed: 31,
  flaky: 33,
  blocked: 90,
};

const paint = (on: boolean | undefined, code: number, text: string) =>
  on ? `\u001b[${code}m${text}\u001b[0m` : text;

/** Removes control characters so contract text can't move the cursor or recolour the terminal. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const clean = (text: string) => text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");

const INDENT = 2;
const HEADLINE_INDENT = INDENT + 8 + 1 + 7 + 2 + 9 + 2 + 8 + 2;

/** `  FAILED     12.7s       0 AI     $0.00  Discount code takes 10% off`, then the headline below. */
export function formatTestLine(test: TestLineInput, options: TerminalOptions = {}): string {
  if (test.muted && test.verdict !== "passed") {
    const mute = typeof test.muted === "object" ? test.muted : undefined;
    const label = paint(options.color, 2, "MUTED".padEnd(8));
    const ai = `${test.aiCalls} AI`.padStart(9);
    const line = `${" ".repeat(INDENT)}${label} ${formatDuration(test.durationMs).padStart(7)}  ${ai}  ${formatUsd(test.costUsd).padStart(8)}  ${clean(test.name)}`;
    const why = `${test.verdict}, doesn't count: muted${mute ? ` until ${mute.until} (${clean(mute.reason)})` : ""}`;
    return `${line}\n${" ".repeat(HEADLINE_INDENT)}${why}${test.headline ? `: ${clean(test.headline)}` : ""}`;
  }
  const label = paint(options.color, COLOR[test.verdict], LABEL[test.verdict].padEnd(8));
  const ai = `${test.aiCalls} AI`.padStart(9);
  const line = `${" ".repeat(INDENT)}${label} ${formatDuration(test.durationMs).padStart(7)}  ${ai}  ${formatUsd(test.costUsd).padStart(8)}  ${clean(test.name)}`;
  if (!test.headline || test.verdict === "passed") return line;
  return `${line}\n${" ".repeat(HEADLINE_INDENT)}${clean(test.headline)}`;
}

/** The summary and failure groups printed after the test lines. */
export function formatRunSummary(data: RunData, options: TerminalOptions = {}): string {
  const model = buildModel(data);
  const { run } = model;
  const summary = summarize(run);
  const lines: string[] = [];
  if (run.blocked)
    lines.push(
      `  ${paint(options.color, COLOR.blocked, "Run blocked")} (${words(run.blocked.reason)}): ${clean(run.blocked.message)}`,
      "",
    );
  if (model.groups.length > 0) {
    lines.push(`  ${paint(options.color, 1, "What went wrong")}`);
    for (const group of model.groups) {
      const label = group.reason
        ? `blocked, ${words(group.reason)}`
        : group.cause
          ? CAUSE_LABEL[group.cause].toLowerCase()
          : "unknown cause";
      lines.push(
        `  ${paint(options.color, COLOR[group.tests[0]?.verdict ?? "failed"], "●")} ${clean(group.headline)}`,
        `      ${label} · ${plural(group.tests.length, "test")}: ${group.tests.map((t) => `${clean(t.name)} (${clean(t.file)}${t.failingStep ? `, step ${stepLabel(t.failingStep.step)}` : ""})`).join(", ")}`,
      );
    }
    lines.push("");
  }
  if (model.muted.length > 0) {
    lines.push(`  ${paint(options.color, 1, "Muted")} (they ran; their results don't count)`);
    for (const test of model.muted)
      lines.push(
        `  ${paint(options.color, 2, "○")} ${clean(test.name)} (${clean(test.file)}): ${test.verdict}${test.muted?.until ? `, muted until ${test.muted.until}: ${clean(test.muted.reason)}` : ""}`,
      );
    lines.push("");
  }
  const expired = model.tests.filter((t) => t.muteExpired);
  for (const test of expired)
    lines.push(
      `  The mute of ${clean(test.file)} ended on ${test.muteExpired?.until}: it counts again.`,
    );
  const suggested = model.tests.filter((t) => t.muteSuggested);
  for (const test of suggested)
    lines.push(
      `  ${clean(test.file)} looks flaky (${clean(test.muteSuggested?.reason ?? "")}): mute it while it's fixed with \`mute ${clean(test.file)} --reason … --until 14d\`.`,
    );
  if (expired.length + suggested.length > 0) lines.push("");
  const toReview = model.heals.filter(({ heal }) => heal.status === "pending").length;
  if (toReview > 0) lines.push(`  ${plural(toReview, "fix", "fixes")} to review`, "");
  if (model.softWarnings.length > 0)
    lines.push(`  ${plural(model.softWarnings.length, "soft-check warning")} (not failures)`, "");
  const ai = plural(summary.aiCalls, "AI call");
  lines.push(
    `  ${summary.line} · ${formatDuration(summary.durationMs)} · ${ai} · ${costText(summary.costUsd, summary.unpricedCalls, model.subscriptionCalls, formatUsd)}`,
  );
  return lines.join("\n");
}

/** Everything `results` prints: the run line, a line per test, then the summary. */
export function formatTerminal(data: RunData, options: TerminalOptions = {}): string {
  const { run } = data;
  const where = [run.project, run.environment, run.target].filter(Boolean).join(" · ");
  const lines = [`Run ${run.runId}  ${clean(where)}`, ""];
  for (const test of run.tests) {
    const mute = data.tests.find((t) => t.testId === test.testId)?.muted;
    lines.push(formatTestLine(mute ? { ...test, muted: mute } : test, options));
  }
  if (run.tests.length > 0) lines.push("");
  lines.push(formatRunSummary(data, options));
  return lines.join("\n");
}
