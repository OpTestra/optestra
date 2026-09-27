import { type GitHub, GitHubError, type GitHubResponse } from "./transport.js";

// What the Action does on GitHub, over the one transport: find the pull
// request, keep ONE comment per check name up to date (CI-2), report a check
// run (CI-3), and read the PR's changed files (AGT-4).

export interface Repo {
  owner: string;
  repo: string;
}

function expectOk(response: GitHubResponse, what: string): unknown {
  if (response.ok) return response.body;
  const message =
    (response.body as { message?: string } | null)?.message ?? `HTTP ${response.status}`;
  throw new GitHubError(`${what} failed: ${message}`, response.status);
}

/** Every item of a list endpoint (100 per page, at most `maxPages` pages). */
async function list<T>(github: GitHub, path: string, what: string, maxPages = 30): Promise<T[]> {
  const items: T[] = [];
  const join = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const batch = expectOk(
      await github.request("GET", `${path}${join}per_page=100&page=${page}`),
      what,
    ) as T[];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

/** The open pull request for a commit (for `deployment_status` and `push` runs). */
export async function pullRequestForCommit(
  github: GitHub,
  { owner, repo }: Repo,
  sha: string,
): Promise<number | null> {
  const pulls = expectOk(
    await github.request("GET", `/repos/${owner}/${repo}/commits/${sha}/pulls`),
    "Finding the pull request",
  ) as { number: number; state: string }[];
  return pulls.find((p) => p.state === "open")?.number ?? pulls[0]?.number ?? null;
}

export interface CommentResult {
  action: "created" | "updated";
  id: number;
  url: string | null;
}

/**
 * The sticky comment: the one comment whose body starts with `marker` is
 * edited in place; only when there is none is a comment created.
 */
export async function upsertComment(
  github: GitHub,
  { owner, repo }: Repo,
  pr: number,
  marker: string,
  body: string,
): Promise<CommentResult> {
  const comments = await list<{ id: number; body?: string; html_url?: string }>(
    github,
    `/repos/${owner}/${repo}/issues/${pr}/comments`,
    "Reading the pull request's comments",
  );
  const existing = comments.find((c) => (c.body ?? "").startsWith(marker));
  if (existing) {
    const updated = expectOk(
      await github.request("PATCH", `/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
        body,
      }),
      "Updating the comment",
    ) as { html_url?: string };
    return { action: "updated", id: existing.id, url: updated.html_url ?? null };
  }
  const created = expectOk(
    await github.request("POST", `/repos/${owner}/${repo}/issues/${pr}/comments`, { body }),
    "Creating the comment",
  ) as { id: number; html_url?: string };
  return { action: "created", id: created.id, url: created.html_url ?? null };
}

export type Conclusion = "success" | "failure" | "neutral";

export interface CheckRunInput {
  name: string;
  headSha: string;
  conclusion: Conclusion;
  title: string;
  summary: string;
  detailsUrl?: string;
}

/** GitHub caps a check run's output summary at 65,535 characters. */
export const CHECK_SUMMARY_LIMIT = 65_535;

export async function createCheckRun(
  github: GitHub,
  { owner, repo }: Repo,
  input: CheckRunInput,
): Promise<{ id: number; url: string | null }> {
  const created = expectOk(
    await github.request("POST", `/repos/${owner}/${repo}/check-runs`, {
      name: input.name,
      head_sha: input.headSha,
      status: "completed",
      conclusion: input.conclusion,
      completed_at: new Date().toISOString(),
      ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
      output: {
        title: input.title.slice(0, 255),
        summary: input.summary.slice(0, CHECK_SUMMARY_LIMIT),
      },
    }),
    "Creating the check run",
  ) as { id: number; html_url?: string };
  return { id: created.id, url: created.html_url ?? null };
}

export interface PullFile {
  filename: string;
  status: string;
  /** Missing for binary or very large diffs. */
  patch?: string;
}

export async function pullRequestFiles(
  github: GitHub,
  { owner, repo }: Repo,
  pr: number,
): Promise<PullFile[]> {
  // GitHub lists at most 3,000 files per pull request.
  return list<PullFile>(
    github,
    `/repos/${owner}/${repo}/pulls/${pr}/files`,
    "Reading the pull request's files",
  );
}
