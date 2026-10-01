import { brand } from "@optestra/brand";
import { formatDuration, formatUsd, stepLabel } from "@optestra/contract";
import { escapeMarkdown as md, markdownCode as code } from "./escape.js";
import {
  buildModel,
  CAUSE_LABEL,
  costText,
  type FailureGroup,
  plural,
  type ReportModel,
  type RunData,
  runStatus,
  VERDICT_LABEL,
  VERDICTS,
  words,
} from "./model.js";

// The Markdown summary for the PR comment (CI-2) and the job summary (CI-5).
// Short by default, details in <details>, and capped to fit GitHub's comment limit.

/** GitHub rejects comments over 65,536 characters; leave room for the Action's own lines. */
export const GITHUB_COMMENT_LIMIT = 65_536;
export const DEFAULT_MARKDOWN_MAX = 60_000;

/**
 * Screenshots are linked as `artifact:<path relative to the run folder>`.
 * The Action swaps these for uploaded artifact URLs with `fillArtifactLinks`.
 */
export const ARTIFACT_LINK_PREFIX = "artifact:";

export interface MarkdownOptions {
  /** Maximum length in characters. Default 60,000. */
  maxLength?: number;
  /** Link to the full report; without it the summary names the report command. */
  reportUrl?: string;
  /** Turns a run-folder path into a URL; default leaves an `artifact:` placeholder. */
  artifactUrl?: (path: string) => string;
  /** Heading level of the title (default 2). */
  headingLevel?: 1 | 2 | 3;
  productName?: string;
  cliName?: string;
}

/** Replaces every `artifact:` placeholder link; `url` returns null to drop the link text's target. */
export function fillArtifactLinks(markdown: string, url: (path: string) => string | null): string {
  return markdown.replace(/\]\(artifact:([^)\s]+)\)/g, (_match, path: string) => {
    const target = url(decodeURI(path));
    return target === null ? "]" : `](${target})`;
  });
}

interface Parts {
  model: ReportModel;
  options: Required<Pick<MarkdownOptions, "productName" | "cliName">> & MarkdownOptions;
}

const cell = (text: string) => md(text);

function linkTo(parts: Parts, path: string): string {
  const url = parts.options.artifactUrl
    ? parts.options.artifactUrl(path)
    : `${ARTIFACT_LINK_PREFIX}${encodeURI(path)}`;
  return `[screenshot](${url})`;
}

function title(parts: Parts): string {
  const { model, options } = parts;
  const status = runStatus(model);
  const hashes = "#".repeat(options.headingLevel ?? 2);
  const word = status === "empty" ? "No tests ran" : VERDICT_LABEL[status];
  const where = [model.run.project, model.run.environment].filter(Boolean).join(" · ");
  return `${hashes} ${md(options.productName)}: ${word} · ${md(where)}`;
}

function statusTable(model: ReportModel): string {
  const { totals } = model.run;
  const head = VERDICTS.map((v) => VERDICT_LABEL[v]).join(" | ");
  const row = VERDICTS.map((v) => String(totals[v])).join(" | ");
  return `| ${head} |\n|${VERDICTS.map(() => "---:").join("|")}|\n| ${row} |`;
}

function costLine(model: ReportModel): string {
  const { run } = model;
  return `${plural(run.totals.tests, "test")} in ${formatDuration(run.durationMs)} · ${plural(run.cost.aiCalls, "AI call")} · ${md(costText(run.cost.usd, run.cost.unpricedCalls, model.subscriptionCalls, formatUsd))}`;
}

function groupBlock(parts: Parts, group: FailureGroup, withTests: boolean): string {
  const first = group.tests[0];
  const label = group.reason
    ? `blocked, ${words(group.reason)}`
    : group.cause
      ? CAUSE_LABEL[group.cause].toLowerCase()
      : VERDICT_LABEL[first?.verdict ?? "failed"].toLowerCase();
  const verdict = VERDICT_LABEL[first?.verdict ?? "failed"];
  const lines = [
    group.headline.toLowerCase().startsWith(verdict.toLowerCase())
      ? `**${md(group.headline)}**  `
      : `**${verdict}:** ${md(group.headline)}  `,
    `${md(label)} · affects ${plural(group.tests.length, "test")}${first?.screenshot ? ` · ${linkTo(parts, first.screenshot)}` : ""}`,
  ];
  const check = first?.failingCheck?.check;
  if (check && (check.expected !== null || check.actual !== null))
    lines.push(`Expected ${code(check.expected ?? "—")}, actual ${code(check.actual ?? "—")}`);
  if (withTests) {
    const shown = group.tests.slice(0, 10);
    for (const t of shown)
      lines.push(
        `- ${md(t.name)} (${code(t.file)}${t.failingStep ? `, step ${stepLabel(t.failingStep.step)}` : ""})`,
      );
    if (group.tests.length > shown.length)
      lines.push(`- and ${plural(group.tests.length - shown.length, "more test")}`);
  }
  return lines.join("\n");
}

function failuresBlock(parts: Parts, limit: number, withTests: boolean): string {
  const { groups } = parts.model;
  if (groups.length === 0) return "";
  const shown = groups.slice(0, limit);
  const more =
    groups.length > shown.length
      ? `\n\n…and ${plural(groups.length - shown.length, "more issue")} in the full report.`
      : "";
  return `${"#".repeat((parts.options.headingLevel ?? 2) + 1)} What went wrong\n\n${shown
    .map((g) => groupBlock(parts, g, withTests))
    .join("\n\n")}${more}`;
}

function healsBlock(parts: Parts, limit: number): string {
  const { heals } = parts.model;
  if (heals.length === 0) return "";
  const rows = heals.slice(0, limit).map(({ test, heal }) => {
    const change = heal.changes.map((c) => `${c.target} ${code(c.before)} → ${code(c.after)}`);
    const signals = heal.signals
      .map((s) => `${words(s.name)} ${Math.round(s.score * 100)}%`)
      .join(", ");
    const how = heal.level === "fixer" ? "by AI, " : heal.level ? "no AI, " : "";
    const state =
      heal.status === "accepted"
        ? `, applied${heal.appliedBy === "auto" ? " by the auto policy" : ""}`
        : heal.status === "rejected"
          ? ", rejected"
          : "";
    const warn =
      heal.classification === "behavior_change"
        ? " **The app's behaviour may have changed — check before accepting.**"
        : "";
    return `- ${md(test.name)}, step ${heal.stepIndex + 1}: ${change.join("; ")} (${how}confidence ${Math.round(heal.confidence * 100)}%, ${md(words(heal.classification))}${state}${signals ? `; ${md(signals)}` : ""})${warn}`;
  });
  if (heals.length > limit)
    rows.push(`- and ${plural(heals.length - limit, "more fix", "more fixes")}`);
  return `<details><summary>Fixes to review (${heals.length})</summary>\n\n${rows.join("\n")}\n\n</details>`;
}

function warningsBlock(parts: Parts, limit: number): string {
  const list = parts.model.softWarnings;
  if (list.length === 0) return "";
  const rows = list
    .slice(0, limit)
    .map(({ test, warning }) => `- ${md(test.name)}: ${md(warning.check.generated.description)}`);
  if (list.length > limit) rows.push(`- and ${plural(list.length - limit, "more warning")}`);
  return `<details><summary>Soft-check warnings (${list.length}, never failures)</summary>\n\n${rows.join("\n")}\n\n</details>`;
}

function mutedBlock(parts: Parts, limit: number): string {
  const { model } = parts;
  const expired = model.tests.filter((t) => t.muteExpired);
  const suggested = model.tests.filter((t) => t.muteSuggested);
  if (model.muted.length + expired.length + suggested.length === 0) return "";
  const rows = [
    ...model.muted
      .slice(0, limit)
      .map(
        (t) =>
          `- ${md(t.name)} (${code(t.file)}): ${VERDICT_LABEL[t.verdict].toLowerCase()}, muted${t.muted?.until ? ` until ${t.muted.until}` : ""}: ${md(t.muted?.reason ?? "")}`,
      ),
    ...expired.map(
      (t) => `- ${md(t.name)}: its mute ended on ${t.muteExpired?.until}, it counts again`,
    ),
    ...suggested.map(
      (t) =>
        `- ${md(t.name)} looks flaky (${md(t.muteSuggested?.reason ?? "")}): consider muting it while it's fixed`,
    ),
  ];
  return `<details><summary>Muted tests (${model.muted.length}; they ran, their results don't count)</summary>\n\n${rows.join("\n")}\n\n</details>`;
}

function aiBlock(parts: Parts, limit: number): string {
  const rows = parts.model.tests
    .filter((t) => t.result?.ai.recent || t.ref.aiCalls > 0)
    .slice(0, limit)
    .map((t) => {
      const recent = t.result?.ai.recent;
      const history = recent
        ? `used AI ${plural(recent.calls, "time")} in its last ${plural(recent.runs, "run")}`
        : "no history yet";
      return `| ${cell(t.name)} | ${t.ref.aiCalls} | ${md(formatUsd(t.ref.costUsd))} | ${history} |`;
    });
  if (rows.length === 0) return "";
  return `<details><summary>AI use per test</summary>\n\n| Test | AI calls | Cost | History |\n|---|---:|---:|---|\n${rows.join("\n")}\n\n</details>`;
}

function testsBlock(parts: Parts, limit: number): string {
  const { tests } = parts.model;
  if (tests.length === 0) return "";
  const rows = tests
    .slice(0, limit)
    .map(
      (t) =>
        `| ${VERDICT_LABEL[t.verdict]}${t.muted ? " (muted)" : ""}${t.mocks.length ? " (mocked)" : ""} | ${cell(t.name)} | ${formatDuration(t.ref.durationMs)} | ${t.ref.aiCalls} | ${md(formatUsd(t.ref.costUsd))} |`,
    );
  if (tests.length > limit)
    rows.push(`| | and ${plural(tests.length - limit, "more test")} | | | |`);
  return `<details><summary>All tests (${tests.length})</summary>\n\n| Verdict | Test | Time | AI calls | Cost |\n|---|---|---:|---:|---:|\n${rows.join("\n")}\n\n</details>`;
}

function footer(parts: Parts): string {
  const { options, model } = parts;
  return options.reportUrl
    ? `[See the full report](${options.reportUrl}) · run ${code(model.run.runId)}`
    : `See the full report: ${code(`${options.cliName} report`)} · run ${code(model.run.runId)}`;
}

/** Levels of detail, most first: the summary uses the first that fits. */
const LEVELS = [
  { groups: 50, tests: true, list: 200 },
  { groups: 20, tests: true, list: 50 },
  { groups: 10, tests: false, list: 20 },
  { groups: 5, tests: false, list: 0 },
  { groups: 1, tests: false, list: 0 },
];

function compose(parts: Parts, level: (typeof LEVELS)[number]): string {
  const { model } = parts;
  const blocked = model.run.blocked
    ? `> **Run blocked (${md(words(model.run.blocked.reason))}):** ${md(model.run.blocked.message)}`
    : "";
  const sections = [
    title(parts),
    blocked,
    statusTable(model),
    costLine(model),
    failuresBlock(parts, level.groups, level.tests),
    level.list > 0 ? healsBlock(parts, level.list) : "",
    level.list > 0 ? warningsBlock(parts, level.list) : "",
    level.list > 0 ? mutedBlock(parts, level.list) : "",
    level.list > 0 ? aiBlock(parts, level.list) : "",
    level.list > 0 ? testsBlock(parts, level.list) : "",
    footer(parts),
  ];
  return `${sections.filter((s) => s !== "").join("\n\n")}\n`;
}

/** Cuts at a line break and closes any open <details> so the page still renders. */
function hardCap(text: string, max: number, tail: string): string {
  const room = Math.max(0, max - tail.length - 32);
  let cut = text.slice(0, room);
  const newline = cut.lastIndexOf("\n");
  if (newline > 0) cut = cut.slice(0, newline);
  const open = (cut.match(/<details>/g) ?? []).length - (cut.match(/<\/details>/g) ?? []).length;
  return `${cut}\n\n…cut to fit.${"\n\n</details>".repeat(Math.max(0, open))}\n\n${tail}\n`;
}

/**
 * The run as a short Markdown summary for the PR comment and the job summary:
 * status table, each failure's headline and screenshot link, fixes to review,
 * AI calls and cost, then details collapsed. Never longer than `maxLength`.
 */
export function renderMarkdownSummary(data: RunData, options: MarkdownOptions = {}): string {
  const parts: Parts = {
    model: buildModel(data),
    options: {
      ...options,
      productName: options.productName ?? brand.productName,
      cliName: options.cliName ?? brand.cliName,
    },
  };
  const max = Math.min(options.maxLength ?? DEFAULT_MARKDOWN_MAX, GITHUB_COMMENT_LIMIT);
  let text = "";
  for (const level of LEVELS) {
    text = compose(parts, level);
    if (text.length <= max) return text;
  }
  return hardCap(text, max, footer(parts));
}
