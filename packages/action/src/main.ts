import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildComment, commentMarker, linkedArtifacts } from "./comment.js";
import { checkOutcome, type Summary } from "./conclusion.js";
import { expectationChanges, expectationNotice } from "./expectations.js";
import {
  createCheckRun,
  pullRequestFiles,
  pullRequestForCommit,
  type Repo,
  upsertComment,
} from "./github.js";
import { createGitHub, type Fetch, GitHubError } from "./transport.js";

// The Action's Node steps (action.yml runs `node dist/cli.js <phase>`).
// Imports only Node built-ins, so it runs straight from the action's folder.
//   locate  the run folder this job's `run` wrote
//   stage   copies the first failure screenshots out, for one-file artifacts
//   post    job summary, sticky PR comment, check run, outputs, job exit code

export type Env = Readonly<Record<string, string | undefined>>;

export interface Io {
  env: Env;
  stdout: (text: string) => void;
  fetch?: Fetch;
  now?: () => number;
}

export const MAX_SCREENSHOTS = 5;

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Milliseconds since the epoch, from a ULID's first 10 characters. */
export function ulidTime(id: string): number | null {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  let ms = 0;
  for (const char of id.slice(0, 10)) ms = ms * 32 + ULID_CHARS.indexOf(char);
  return ms;
}

function output(io: Io, name: string, value: string | number): void {
  const file = io.env.GITHUB_OUTPUT;
  const line = `${name}=${String(value).replace(/[\r\n]+/g, " ")}\n`;
  if (file) appendFileSync(file, line);
  else io.stdout(`output ${line}`);
}

const warn = (io: Io, message: string) =>
  io.stdout(`::warning::${message.replace(/\r?\n/g, "%0A")}\n`);

/** Newest run folder started at or after `sinceMs`, searching up from `dir` for `<dataDir>/runs`. */
export function locateRun(dir: string, dataDir: string, sinceMs: number): string | null {
  for (let current = resolve(dir); ; current = dirname(current)) {
    const runs = join(current, dataDir, "runs");
    if (existsSync(runs)) {
      const newest = readdirSync(runs, { withFileTypes: true })
        .filter((e) => e.isDirectory() && (ulidTime(e.name) ?? -1) >= sinceMs - 2000)
        .map((e) => e.name)
        .sort()
        .at(-1);
      if (newest) return join(runs, newest);
    }
    if (dirname(current) === current) return null;
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function phaseLocate(io: Io): number {
  const { env } = io;
  const since = Number(env.RUN_STARTED_MS ?? "0");
  const dir = locateRun(env.WORKING_DIR ?? ".", env.DATA_DIR ?? ".data", since);
  if (!dir) {
    warn(io, "No results folder was written by this run.");
    output(io, "run-dir", "");
    return 0;
  }
  output(io, "run-dir", dir);
  return 0;
}

function phaseStage(io: Io): number {
  const { env } = io;
  const out = env.OUT_DIR as string;
  const runDir = env.RUN_DIR ?? "";
  const markdownFile = join(out, "summary.md");
  const shots =
    runDir && existsSync(markdownFile) ? linkedArtifacts(readFileSync(markdownFile, "utf8")) : [];
  const staged: Record<string, string> = {};
  mkdirSync(join(out, "shots"), { recursive: true });
  const prefix = env.ARTIFACT_PREFIX ?? "run";
  shots
    .filter((path) => /\.(png|jpe?g)$/i.test(path) && existsSync(join(runDir, path)))
    .slice(0, MAX_SCREENSHOTS)
    .forEach((path, i) => {
      const to = join(
        out,
        "shots",
        `${prefix}-failure-${i + 1}${path.slice(path.lastIndexOf("."))}`,
      );
      copyFileSync(join(runDir, path), to);
      staged[path] = String(i + 1);
      output(io, `shot${i + 1}`, to);
    });
  writeFileSync(join(out, "shots.json"), JSON.stringify(staged));
  return 0;
}

interface Event {
  pull_request?: { number: number; head: { sha: string; repo: { full_name: string } | null } };
  deployment?: { sha: string };
  deployment_status?: { state: string; environment_url?: string };
}

export async function phasePost(io: Io): Promise<number> {
  const { env } = io;
  const out = env.OUT_DIR as string;
  const cliName = env.CLI_NAME ?? "cli";
  const checkName = env.CHECK_NAME || "Tests";
  const exitCode =
    env.EXIT_CODE === undefined || env.EXIT_CODE === "" ? null : Number(env.EXIT_CODE);
  const summary = readJson<Summary>(join(out, "summary.json"));
  const markdown = existsSync(join(out, "summary.md"))
    ? readFileSync(join(out, "summary.md"), "utf8")
    : `## ${checkName}: the run could not finish\n\nNo results were written (exit code ${exitCode ?? "unknown"}). See the job log.\n`;
  const outcome = checkOutcome(exitCode, summary);

  // Links: staged screenshots have their own one-file artifacts; everything else is in the report.
  const staged = readJson<Record<string, string>>(join(out, "shots.json")) ?? {};
  const report = env.REPORT_URL || null;
  const artifactUrl = (path: string): string | null => {
    const shot = staged[path];
    const own = shot ? env[`SHOT${shot}_URL`] : undefined;
    return own || report;
  };

  const event = env.GITHUB_EVENT_PATH ? (readJson<Event>(env.GITHUB_EVENT_PATH) ?? {}) : {};
  const [owner, name] = (env.GITHUB_REPOSITORY ?? "/").split("/");
  const repo: Repo = { owner: owner ?? "", repo: name ?? "" };
  const headSha = event.pull_request?.head.sha ?? event.deployment?.sha ?? env.GITHUB_SHA ?? "";
  const fork =
    event.pull_request !== undefined &&
    event.pull_request.head.repo?.full_name !== env.GITHUB_REPOSITORY;
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  const github =
    env.GITHUB_TOKEN && env.GITHUB_API_URL
      ? createGitHub({
          apiUrl: env.GITHUB_API_URL,
          token: env.GITHUB_TOKEN,
          ...(io.fetch ? { fetch: io.fetch } : {}),
        })
      : null;
  const wantComment = env.COMMENT !== "off";
  const wantCheck = env.CHECK !== "off";

  let pr = event.pull_request?.number ?? null;
  if (!pr && github && wantComment && headSha && event.deployment)
    pr = await pullRequestForCommit(github, repo, headSha).catch((error: Error) => {
      warn(io, `Could not find the pull request for ${headSha}: ${error.message}`);
      return null;
    });

  let notice = "";
  if (pr && github)
    notice = await pullRequestFiles(github, repo, pr)
      .then((files) => expectationNotice(expectationChanges(files)))
      .catch((error: Error) => {
        warn(
          io,
          `Could not read the pull request's files for the Expect-line check: ${error.message}`,
        );
        return "";
      });

  const marker = commentMarker(cliName, checkName);
  const body = buildComment({
    marker,
    markdown,
    summary,
    cliName,
    artifactUrl,
    ...(notice ? { expectationNotice: notice } : {}),
    fork,
    ...(runUrl ? { runUrl } : {}),
    ...(env.NOTE ? { note: env.NOTE } : {}),
  });

  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, body.slice(marker.length + 1));

  const denied = (what: string, error: unknown) => {
    const status = error instanceof GitHubError ? error.status : 0;
    const why =
      status === 403 && fork
        ? "the token of a pull request from a fork is read-only. The results are in the job summary."
        : status === 403
          ? `the token lacks permission (the workflow needs ${what === "comment" ? "pull-requests: write" : "checks: write"}).`
          : error instanceof Error
            ? error.message
            : String(error);
    warn(io, `Could not post the ${what}: ${why}`);
  };

  if (wantComment && github && pr)
    await upsertComment(github, repo, pr, marker, body)
      .then((r) => io.stdout(`PR comment ${r.action}: ${r.url ?? r.id}\n`))
      .catch((error) => denied("comment", error));
  else if (wantComment && !pr) io.stdout("No pull request for this run: no comment.\n");

  if (wantCheck && github && headSha)
    await createCheckRun(github, repo, {
      name: checkName,
      headSha,
      conclusion: outcome.conclusion,
      title: outcome.title,
      summary: body.slice(marker.length + 1),
      ...(runUrl ? { detailsUrl: runUrl } : {}),
    })
      .then(() => io.stdout(`Check "${checkName}": ${outcome.conclusion} (${outcome.title})\n`))
      .catch((error) => denied("check", error));

  output(io, "conclusion", outcome.conclusion);
  if (summary)
    for (const verdict of ["tests", "passed", "healed", "failed", "flaky", "blocked"] as const)
      output(io, verdict, summary.totals[verdict]);
  io.stdout(`${checkName}: ${outcome.conclusion}: ${outcome.title}\n`);
  // The job fails only on real failures; blocked stays neutral (CI-3).
  return outcome.conclusion === "failure" ? 1 : 0;
}

export async function main(phase: string | undefined, io: Io): Promise<number> {
  if (phase === "locate") return phaseLocate(io);
  if (phase === "stage") return phaseStage(io);
  if (phase === "post") return phasePost(io);
  io.stdout(`Unknown phase "${phase}": use locate, stage or post.\n`);
  return 2;
}
