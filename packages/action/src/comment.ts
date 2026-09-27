import type { Summary } from "./conclusion.js";

// The PR comment (CI-2) and job summary (CI-5): the CLI's Markdown summary
// (EVD-0's renderMarkdownSummary: status table, failure headlines with
// screenshot links, fixes to review, cost, AI use, details collapsed), plus what
// only the Action knows: the hidden marker that makes the comment sticky, the
// AGT-4 notice, the fork notice, how to accept fixes, and real artifact links.

/** GitHub rejects comments over 65,536 characters. */
export const COMMENT_LIMIT = 65_536;

/** The hidden first line that finds this check's comment again on every push. */
export function commentMarker(cliName: string, checkName: string): string {
  const key = checkName.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `<!-- ${cliName}:pr-comment:${key} -->`;
}

/**
 * Replaces every `artifact:<path>` link the summary leaves (same format as
 * @testament/report's fillArtifactLinks); `url` returns null to drop the link.
 */
export function fillArtifactLinks(markdown: string, url: (path: string) => string | null): string {
  return markdown.replace(/\]\(artifact:([^)\s]+)\)/g, (_match, path: string) => {
    const target = url(decodeURI(path));
    return target === null ? "]" : `](${target})`;
  });
}

/** Artifact paths the summary links to, in order of first appearance. */
export function linkedArtifacts(markdown: string): string[] {
  const paths: string[] = [];
  for (const match of markdown.matchAll(/\]\(artifact:([^)\s]+)\)/g)) {
    const path = decodeURI(match[1] as string);
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

export interface CommentInput {
  marker: string;
  /** The CLI's Markdown summary (`results --markdown`), with `artifact:` links. */
  markdown: string;
  summary: Summary | null;
  cliName: string;
  /** Run-folder path → URL (uploaded artifacts); null drops the link. */
  artifactUrl: (path: string) => string | null;
  /** From `expectationNotice`. */
  expectationNotice?: string;
  /** The PR comes from a fork: no secrets (SAF-6). */
  fork?: boolean;
  /** Link to the workflow run. */
  runUrl?: string;
  /** e.g. "merged from 4 shards". */
  note?: string;
  maxLength?: number;
}

function forkNotice(summary: Summary | null): string {
  const missing = summary?.tests.filter((t) => t.blocked?.reason === "missing_secret").length ?? 0;
  return [
    "> [!NOTE]",
    "> This pull request comes from a fork, so the workflow gets no secrets (GitHub's rule, and ours: fork code must never see them).",
    missing > 0
      ? `> ${missing} test${missing === 1 ? " that needs a secret is" : "s that need secrets are"} **Blocked (missing secret)**, not failed. A maintainer can run them from a branch in this repository.`
      : "> Tests that need secrets are Blocked (missing secret), not failed.",
  ].join("\n");
}

function healHint(summary: Summary | null, cliName: string): string {
  const heals = summary?.tests.reduce((n, t) => n + t.heals.length, 0) ?? 0;
  if (heals === 0) return "";
  return `Fixes are suggestions: nothing was committed. To accept them, run \`${cliName} heal --accept all\` (or \`--accept <id>\`) locally and commit the updated recordings.`;
}

/** The whole comment body, never longer than GitHub allows. */
export function buildComment(input: CommentInput): string {
  const max = Math.min(input.maxLength ?? COMMENT_LIMIT, COMMENT_LIMIT);
  const footer = [input.note, input.runUrl ? `[Workflow run](${input.runUrl})` : ""]
    .filter(Boolean)
    .join(" · ");
  const head = [
    input.marker,
    input.expectationNotice ?? "",
    input.fork ? forkNotice(input.summary) : "",
  ].filter(Boolean);
  const tail = [
    healHint(input.summary, input.cliName),
    footer ? `<sub>${footer}</sub>` : "",
  ].filter(Boolean);
  const body = fillArtifactLinks(input.markdown.trim(), input.artifactUrl);
  const join = (summary: string) => `${[...head, summary, ...tail].join("\n\n")}\n`;
  const full = join(body);
  if (full.length <= max) return full;
  // The summary is capped by the CLI already; only the extra lines can push it over.
  const room = max - join("").length - 64;
  let cut = body.slice(0, Math.max(0, room));
  const newline = cut.lastIndexOf("\n");
  if (newline > 0) cut = cut.slice(0, newline);
  const open = (cut.match(/<details>/g) ?? []).length - (cut.match(/<\/details>/g) ?? []).length;
  return join(`${cut}\n\n…cut to fit.${"\n\n</details>".repeat(Math.max(0, open))}`);
}
