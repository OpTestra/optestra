import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildComment, commentMarker, fillArtifactLinks, linkedArtifacts } from "./comment.js";
import { checkOutcome, type Summary } from "./conclusion.js";
import { expectationChanges, expectationNotice } from "./expectations.js";
import { upsertComment } from "./github.js";
import { locateRun, main, ulidTime } from "./main.js";
import { createGitHub, type Fetch } from "./transport.js";

const cli = fileURLToPath(new URL("../../cli/bin/cli.js", import.meta.url));
const fixtures = fileURLToPath(new URL("../../contract/fixtures/v1/", import.meta.url));
const scratch: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "action-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** What the composite's results step writes: the CLI's JSON + Markdown summary of a run folder. */
function results(fixture: string, flags: string[] = []) {
  const out = temp();
  const run = spawnSync(
    process.execPath,
    [
      cli,
      "results",
      join(fixtures, fixture),
      "--json",
      join(out, "summary.json"),
      "--markdown",
      join(out, "summary.md"),
      "--report-url",
      "artifact:index.html",
      ...flags,
    ],
    { encoding: "utf8" },
  );
  return {
    out,
    exitCode: run.status ?? -1,
    summary: JSON.parse(readFileSync(join(out, "summary.json"), "utf8")) as Summary,
    markdown: readFileSync(join(out, "summary.md"), "utf8"),
  };
}

// ── A fake GitHub API: issue comments, check runs, PR files ──────────────────
interface Fake {
  fetch: Fetch;
  comments: { id: number; body: string }[];
  checks: Record<string, unknown>[];
  requests: { method: string; url: string; auth: string | null; redirect?: string }[];
  deny?: number;
  files: { filename: string; status: string; patch?: string }[];
}
function fakeGitHub(): Fake {
  const fake: Fake = {
    comments: [],
    checks: [],
    requests: [],
    files: [],
    fetch: async () => new Response(),
  };
  let next = 100;
  fake.fetch = async (url, init) => {
    const u = new URL(url);
    const headers = init.headers as Record<string, string>;
    fake.requests.push({
      method: init.method ?? "GET",
      url,
      auth: headers.authorization ?? null,
      ...(init.redirect ? { redirect: init.redirect } : {}),
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (fake.deny && init.method !== "GET")
      return json(fake.deny, { message: "Resource not accessible by integration" });
    const m1 = /\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(u.pathname);
    if (m1) {
      if (init.method === "GET") {
        const page = Number(u.searchParams.get("page") ?? "1");
        return json(200, fake.comments.slice((page - 1) * 100, page * 100));
      }
      const comment = { id: next++, body: body.body };
      fake.comments.push(comment);
      return json(201, { ...comment, html_url: `https://github.test/c/${comment.id}` });
    }
    const m2 = /\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(u.pathname);
    if (m2) {
      const comment = fake.comments.find((c) => c.id === Number(m2[1]));
      if (!comment) return json(404, { message: "Not Found" });
      comment.body = body.body;
      return json(200, { ...comment, html_url: `https://github.test/c/${comment.id}` });
    }
    if (u.pathname === "/repos/o/r/check-runs") {
      fake.checks.push(body);
      return json(201, { id: fake.checks.length });
    }
    if (u.pathname === "/repos/o/r/pulls/7/files")
      return json(200, u.searchParams.get("page") === "1" ? fake.files : []);
    if (u.pathname === "/repos/o/r/commits/abc123/pulls")
      return json(200, [{ number: 7, state: "open" }]);
    return json(404, { message: "Not Found" });
  };
  return fake;
}

describe("the check conclusion (CI-3)", () => {
  const table: [string, string[], "success" | "failure" | "neutral"][] = [
    ["all-passed", [], "success"],
    ["failed-product-bug", [], "failure"],
    ["flaky", [], "failure"],
    ["healed", [], "failure"], // heal policy review: a fix waits for approval
    ["healed", ["--healed-passes"], "success"], // heal policy auto
    ["blocked-missing-secret", [], "neutral"], // passed + blocked, no failures
    ["blocked-budget-exceeded", [], "neutral"], // blocked only
  ];
  for (const [fixture, flags, conclusion] of table)
    it(`${fixture}${flags.length ? ` ${flags.join(" ")}` : ""} → ${conclusion}`, () => {
      const r = results(fixture, flags);
      expect(checkOutcome(r.exitCode, r.summary).conclusion).toBe(conclusion);
    });

  it("gives the reason for neutral, and never hides a crash as neutral", () => {
    const r = results("blocked-missing-secret");
    expect(checkOutcome(r.exitCode, r.summary).title).toMatch(
      /1 passed, 1 blocked \(blocked: missing secret\)/,
    );
    expect(checkOutcome(2, null).conclusion).toBe("failure");
    const healed = results("healed");
    expect(checkOutcome(healed.exitCode, healed.summary).title).toBe("1 healed: 1 fix to review");
  });
});

describe("the PR comment (CI-2, AGT-4)", () => {
  const marker = commentMarker("cli", "My Tests");

  it("starts with the hidden marker, links artifacts, and leads with the failure", () => {
    const r = results("failed-product-bug");
    const paths = linkedArtifacts(r.markdown);
    expect(paths[0]).toMatch(/\.png$/);
    expect(paths).toContain("index.html");
    const body = buildComment({
      marker,
      markdown: r.markdown,
      summary: r.summary,
      cliName: "cli",
      artifactUrl: (path) =>
        path.endsWith(".png") ? "https://gh.test/shot-1" : "https://gh.test/report",
      runUrl: "https://gh.test/run/1",
    });
    expect(body.startsWith(`${marker}\n`)).toBe(true);
    expect(marker).toBe("<!-- cli:pr-comment:My-Tests -->");
    expect(body).not.toContain("artifact:");
    expect(body).toContain("[screenshot](https://gh.test/shot-1)");
    expect(body).toContain("[See the full report](https://gh.test/report)");
    // The failing headline is the first thing after the title and the table.
    const failure = body.indexOf("Discount code");
    expect(failure).toBeGreaterThan(0);
    expect(body.indexOf("<details>")).toBeGreaterThan(failure);
  });

  it("puts the expectation-change notice first and shows how to accept fixes", () => {
    const r = results("healed");
    const changes = expectationChanges([
      {
        filename: "tests/cart.test.md",
        status: "modified",
        patch:
          "@@ -1,3 +1,3 @@\n 1. Go to /cart\n-2. Expect: the total is $10\n+2. Expect: a total is shown\n",
      },
      {
        filename: "tests/other.test.md",
        status: "modified",
        patch: "@@\n-1. Click Buy\n+1. Click Purchase\n",
      },
      { filename: "tests/huge.test.md", status: "modified" },
      { filename: "README.md", status: "modified", patch: "+Expect: nothing" },
    ]);
    expect(changes).toEqual([
      { file: "tests/cart.test.md", added: 1, removed: 1, unreadable: false },
      { file: "tests/huge.test.md", added: 0, removed: 0, unreadable: true },
    ]);
    const body = buildComment({
      marker,
      markdown: r.markdown,
      summary: r.summary,
      cliName: "cli",
      artifactUrl: () => null,
      expectationNotice: expectationNotice(changes),
    });
    const notice = body.indexOf("Expectations changed in this PR — review them");
    expect(notice).toBeGreaterThan(0);
    expect(notice).toBeLessThan(body.indexOf("## "));
    expect(body).toContain("`tests/cart.test.md` (1 added, 1 removed)");
    expect(body).toContain("cli heal --accept all");
    // No upload: links are dropped, the text stays.
    expect(body).not.toContain("](");
    expect(expectationNotice([])).toBe("");
  });

  it("stays under GitHub's limit however long the summary is", () => {
    const r = results("failed-product-bug");
    const long = `${r.markdown}\n<details><summary>x</summary>\n\n${"| a | b |\n".repeat(20_000)}`;
    const body = buildComment({
      marker,
      markdown: long,
      summary: r.summary,
      cliName: "cli",
      artifactUrl: () => null,
      expectationNotice: expectationNotice(
        Array.from({ length: 40 }, (_, i) => ({
          file: `t${i}.test.md`,
          added: 1,
          removed: 0,
          unreadable: false,
        })),
      ),
    });
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body.startsWith(marker)).toBe(true);
    expect(body).toContain("…cut to fit.");
    expect(body).toContain("and 20 more files");
    expect((body.match(/<details>/g) ?? []).length).toBe((body.match(/<\/details>/g) ?? []).length);
  });

  it("fills links exactly like the report package's fillArtifactLinks", () => {
    const text = "[a](artifact:tests/x%20y/1.png) and [b](artifact:index.html) and [c](https://x)";
    expect(fillArtifactLinks(text, (p) => (p === "index.html" ? "https://r" : null))).toBe(
      "[a] and [b](https://r) and [c](https://x)",
    );
    expect(linkedArtifacts(text)).toEqual(["tests/x y/1.png", "index.html"]);
  });
});

describe("the sticky comment against a fake GitHub API", () => {
  it("creates one comment, then edits that same comment on every later push", async () => {
    const fake = fakeGitHub();
    fake.comments.push(
      { id: 1, body: "Looks good to me" },
      { id: 2, body: "quoting <!-- cli:pr-comment:T --> here" },
    );
    for (let i = 0; i < 150; i++) fake.comments.push({ id: 1000 + i, body: `chatter ${i}` });
    const github = createGitHub({
      apiUrl: "https://api.github.test",
      token: "tok",
      fetch: fake.fetch,
    });
    const marker = commentMarker("cli", "T");
    const first = await upsertComment(
      github,
      { owner: "o", repo: "r" },
      7,
      marker,
      `${marker}\nrun 1`,
    );
    const second = await upsertComment(
      github,
      { owner: "o", repo: "r" },
      7,
      marker,
      `${marker}\nrun 2`,
    );
    const third = await upsertComment(
      github,
      { owner: "o", repo: "r" },
      7,
      marker,
      `${marker}\nrun 3`,
    );
    expect([first.action, second.action, third.action]).toEqual(["created", "updated", "updated"]);
    expect(second.id).toBe(first.id);
    const ours = fake.comments.filter((c) => c.body.startsWith(marker));
    expect(ours).toEqual([{ id: first.id, body: `${marker}\nrun 3` }]);
    // It read past the first page to find it.
    expect(fake.requests.some((r) => r.url.includes("page=2"))).toBe(true);
  });

  it("sends only to the API host, with the token, never following redirects", async () => {
    const fake = fakeGitHub();
    const github = createGitHub({
      apiUrl: "https://api.github.test/",
      token: "tok",
      fetch: fake.fetch,
    });
    await github.request("GET", "/repos/o/r/check-runs");
    // A path can't name another host: it stays a path on the API host.
    await github.request("GET", "//evil.test/x");
    await expect(github.request("GET", "repos")).rejects.toThrow(/bad API path/);
    expect(fake.requests).toEqual([
      {
        method: "GET",
        url: "https://api.github.test/repos/o/r/check-runs",
        auth: "Bearer tok",
        redirect: "error",
      },
      {
        method: "GET",
        url: "https://api.github.test//evil.test/x",
        auth: "Bearer tok",
        redirect: "error",
      },
    ]);
  });
});

describe("post (the whole Node step)", () => {
  function setup(fixture: string, event: Record<string, unknown>) {
    const r = results(fixture);
    const dir = temp();
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify(event));
    const files = { output: join(dir, "output"), summary: join(dir, "step-summary.md") };
    writeFileSync(files.output, "");
    const env = {
      OUT_DIR: r.out,
      EXIT_CODE: String(r.exitCode),
      CLI_NAME: "cli",
      CHECK_NAME: "Tests",
      GITHUB_TOKEN: "tok",
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SHA: "merge-sha",
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      GITHUB_SERVER_URL: "https://github.test",
      GITHUB_RUN_ID: "42",
      REPORT_URL: "https://github.test/o/r/actions/runs/42/artifacts/9",
    };
    return { env, files, r };
  }
  const pr = (fork: boolean) => ({
    pull_request: {
      number: 7,
      head: { sha: "head-sha", repo: { full_name: fork ? "someone/r" : "o/r" } },
    },
  });

  it("writes the job summary, the comment and a check on the PR's head commit", async () => {
    const fake = fakeGitHub();
    fake.files = [
      { filename: "tests/a.test.md", status: "modified", patch: "+3. Expect: it works" },
    ];
    const { env, files } = setup("failed-product-bug", pr(false));
    const out: string[] = [];
    const code = await main("post", { env, stdout: (t) => out.push(t), fetch: fake.fetch });
    expect(code).toBe(1);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]?.body).toContain("Expectations changed in this PR");
    expect(fake.checks).toMatchObject([
      { name: "Tests", head_sha: "head-sha", conclusion: "failure", status: "completed" },
    ]);
    const summary = readFileSync(files.summary, "utf8");
    expect(summary).not.toContain("<!--");
    expect(summary).toContain("Discount code");
    expect(readFileSync(files.output, "utf8")).toContain("conclusion=failure\n");
    expect(readFileSync(files.output, "utf8")).toContain("failed=1\n");
    // A second push edits the same comment.
    await main("post", { env, stdout: () => {}, fetch: fake.fetch });
    expect(fake.comments).toHaveLength(1);
  });

  it("on a fork PR: blocked tests are explained, a read-only token only warns, the job doesn't fail", async () => {
    const fake = fakeGitHub();
    fake.deny = 403;
    const { env, files } = setup("blocked-missing-secret", pr(true));
    const out: string[] = [];
    const code = await main("post", { env, stdout: (t) => out.push(t), fetch: fake.fetch });
    expect(code).toBe(0); // neutral never fails the job
    const log = out.join("");
    expect(log).toContain(
      "::warning::Could not post the comment: the token of a pull request from a fork is read-only",
    );
    expect(log).toContain("::warning::Could not post the check");
    const summary = readFileSync(files.summary, "utf8");
    expect(summary).toContain("comes from a fork");
    expect(summary).toContain("1 test that needs a secret is **Blocked (missing secret)**");
  });

  it("finds the PR of a deployment_status run by its commit", async () => {
    const fake = fakeGitHub();
    const { env } = setup("all-passed", {
      deployment: { sha: "abc123" },
      deployment_status: { state: "success", environment_url: "https://pr-7.vercel.app" },
    });
    expect(await main("post", { env, stdout: () => {}, fetch: fake.fetch })).toBe(0);
    expect(fake.comments).toHaveLength(1);
    expect(fake.checks).toMatchObject([{ head_sha: "abc123", conclusion: "success" }]);
  });

  it("with no results: a failed check that says the run could not finish", async () => {
    const fake = fakeGitHub();
    const { env } = setup("all-passed", pr(false));
    const empty = temp();
    const code = await main("post", {
      env: { ...env, OUT_DIR: empty, EXIT_CODE: "2" },
      stdout: () => {},
      fetch: fake.fetch,
    });
    expect(code).toBe(1);
    expect(fake.checks).toMatchObject([
      {
        conclusion: "failure",
        output: { title: "The run could not finish: no results were written" },
      },
    ]);
  });
});

describe("locate and stage", () => {
  it("finds the newest run folder this job started, searching up from the working directory", () => {
    const root = temp();
    const runs = join(root, ".data", "runs");
    const old = "01J0000000AAAAAAAAAAAAAAAA";
    const now = Date.now();
    const encode = (ms: number) => {
      const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
      let out = "";
      for (let i = 0; i < 10; i++) {
        out = chars[ms % 32] + out;
        ms = Math.floor(ms / 32);
      }
      return `${out}AAAAAAAAAAAAAAAA`;
    };
    const fresh = encode(now);
    expect(ulidTime(fresh)).toBe(now);
    mkdirSync(join(runs, old), { recursive: true });
    mkdirSync(join(root, "sub", "dir"), { recursive: true });
    expect(locateRun(join(root, "sub", "dir"), ".data", now - 1000)).toBeNull();
    mkdirSync(join(runs, fresh), { recursive: true });
    expect(locateRun(join(root, "sub", "dir"), ".data", now - 1000)).toBe(join(runs, fresh));
  });

  it("stages the first failure screenshots under unique names", async () => {
    const r = results("failed-product-bug");
    const out: string[] = [];
    const output = join(r.out, "gh-output");
    writeFileSync(output, "");
    await main("stage", {
      env: {
        OUT_DIR: r.out,
        RUN_DIR: join(fixtures, "failed-product-bug"),
        ARTIFACT_PREFIX: "t-ci",
        GITHUB_OUTPUT: output,
      },
      stdout: (t) => out.push(t),
    });
    expect(readFileSync(output, "utf8")).toMatch(/^shot1=.*t-ci-failure-1\.png$/m);
    const staged = JSON.parse(readFileSync(join(r.out, "shots.json"), "utf8"));
    expect(Object.values(staged)).toEqual(["1"]);
  });
});
