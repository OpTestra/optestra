import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brand } from "@optestra/brand";
import { afterAll, describe, expect, it } from "vitest";
import {
  branchDir,
  branchRecordings,
  branchSlug,
  detectBranch,
  gitBranch,
  hasGitHubRemote,
  pendingBranches,
  promoteBranch,
  recordingBranch,
  recordingFiles,
} from "./branches.js";
import { recordingPath } from "./index.js";

// Branch-aware recordings (REP-8): where a recording is read and written on a
// feature branch, how the branch is found (env, the GitHub Action, .git), and
// promoting a merged branch's recordings over main's.

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
const PREFIX = `${brand.cliName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_`;

function repo(head: string, remote = "git@github.com:acme/shop.git"): string {
  const dir = temp("branches-repo-");
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "HEAD"), head);
  writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
  return dir;
}

describe("recordingFiles", () => {
  const tests = "/p/tests";
  const branch = { name: "feature/discounts", source: "git" as const };

  it("is main's place with no branch, as before", () => {
    const main = recordingPath(tests, "tests__a");
    expect(recordingFiles(tests, "tests__a", null)).toEqual({
      read: main,
      write: main,
      fromBranch: false,
    });
  });

  it("writes to the branch's folder; reads it when it exists, else main's", () => {
    const dir = temp("branches-files-");
    const testsDir = join(dir, "tests");
    const own = join(branchDir(testsDir, branch.name), "tests__a.steps.json");
    expect(recordingFiles(testsDir, "tests__a", branch)).toEqual({
      read: recordingPath(testsDir, "tests__a"),
      write: own,
      fromBranch: false,
    });
    mkdirSync(join(own, ".."), { recursive: true });
    writeFileSync(own, "{}");
    expect(recordingFiles(testsDir, "tests__a", branch)).toEqual({
      read: own,
      write: own,
      fromBranch: true,
    });
  });

  it("keeps branch names folder-safe", () => {
    expect(branchSlug("feature/discounts")).toBe("feature--discounts");
    expect(branchSlug("fix/a b:c")).toBe("fix--a-b-c");
    // No way out of the branches folder.
    expect(branchSlug("../../etc")).toBe("etc");
    expect(branchSlug("")).toBe("branch");
    expect(branchDir("/p/tests", "feature/x")).toBe(
      join("/p/tests", brand.dataDirName, "branches", "feature--x"),
    );
  });
});

describe("detectBranch", () => {
  const none = temp("branches-nogit-");

  it("takes the explicit variable, then the Action's PR head, then the pushed branch", () => {
    expect(detectBranch({ [`${PREFIX}BRANCH`]: "mine", GITHUB_HEAD_REF: "pr" }, none)).toEqual({
      name: "mine",
      source: "env",
    });
    expect(
      detectBranch({ GITHUB_HEAD_REF: "feature/x", GITHUB_REF: "refs/pull/7/merge" }, none),
    ).toEqual({ name: "feature/x", source: "github" });
    expect(detectBranch({ GITHUB_REF: "refs/heads/feature/y" }, none)).toEqual({
      name: "feature/y",
      source: "github",
    });
    expect(detectBranch({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "z" }, none)).toEqual({
      name: "z",
      source: "github",
    });
    expect(detectBranch({ GITHUB_REF: "refs/tags/v1" }, none)).toBeNull();
  });

  it("reads .git's HEAD without running git: a branch, a detached HEAD, a worktree, no git", () => {
    expect(gitBranch(repo("ref: refs/heads/feature/x\n"))).toBe("feature/x");
    expect(gitBranch(repo("4f1c2e9a7b3d5f60812c4e9d0a1b2c3d4e5f6071\n"))).toBeNull();
    const main = repo("ref: refs/heads/main\n");
    const worktree = temp("branches-wt-");
    const gitdir = join(main, ".git", "worktrees", "wt");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/feature/wt\n");
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
    mkdirSync(join(worktree, "app"));
    expect(gitBranch(join(worktree, "app"))).toBe("feature/wt");
    expect(hasGitHubRemote(worktree)).toBe(true);
    expect(gitBranch(none)).toBeNull();
    expect(detectBranch({}, none)).toBeNull();
  });

  it("knows a GitHub remote", () => {
    expect(hasGitHubRemote(repo("ref: refs/heads/x\n"))).toBe(true);
    expect(hasGitHubRemote(repo("ref: refs/heads/x\n", "https://github.com/acme/shop"))).toBe(true);
    expect(hasGitHubRemote(repo("ref: refs/heads/x\n", "git@gitlab.com:acme/shop.git"))).toBe(
      false,
    );
  });
});

describe("recordingBranch", () => {
  it("auto: only GitHub projects, never the main branch, nothing without git", () => {
    const feature = repo("ref: refs/heads/feature/x\n");
    expect(recordingBranch({ branches: "auto" }, {}, feature)).toEqual({
      name: "feature/x",
      source: "git",
    });
    expect(recordingBranch({ branches: "auto" }, {}, repo("ref: refs/heads/main\n"))).toBeNull();
    expect(recordingBranch({ branches: "auto" }, {}, repo("ref: refs/heads/master\n"))).toBeNull();
    const gitlab = repo("ref: refs/heads/feature/x\n", "git@gitlab.com:a/b.git");
    expect(recordingBranch({ branches: "auto" }, {}, gitlab)).toBeNull();
    expect(recordingBranch({ branches: "on" }, {}, gitlab)?.name).toBe("feature/x");
    expect(recordingBranch({ branches: "off" }, {}, feature)).toBeNull();
    expect(recordingBranch({ branches: "auto" }, {}, temp("branches-plain-"))).toBeNull();
    // In the GitHub Action the PR's head branch counts.
    expect(
      recordingBranch(
        { branches: "auto" },
        { GITHUB_ACTIONS: "true", GITHUB_HEAD_REF: "pr/1" },
        temp("x-"),
      ),
    ).toEqual({ name: "pr/1", source: "github" });
  });

  it("mainBranch names the main one", () => {
    const develop = repo("ref: refs/heads/develop\n");
    expect(recordingBranch({ branches: "auto", mainBranch: "develop" }, {}, develop)).toBeNull();
    expect(
      recordingBranch(
        { branches: "auto", mainBranch: "develop" },
        {},
        repo("ref: refs/heads/main\n"),
      )?.name,
    ).toBe("main");
  });
});

describe("promoteBranch", () => {
  it("moves a branch's recordings over main's and removes its folder; dry runs move nothing", () => {
    const dir = temp("branches-promote-");
    const tests = join(dir, "tests");
    const own = branchDir(tests, "feature/x");
    mkdirSync(own, { recursive: true });
    mkdirSync(join(tests, brand.dataDirName), { recursive: true });
    writeFileSync(recordingPath(tests, "tests__a"), "main a");
    writeFileSync(join(own, "tests__a.steps.json"), "branch a");
    writeFileSync(join(own, "tests__b.steps.json"), "branch b");
    expect(pendingBranches(tests)).toEqual(["feature--x"]);
    expect(branchRecordings(tests, "feature/x")).toEqual(["tests__a", "tests__b"]);

    const dry = promoteBranch(tests, "feature/x", { dryRun: true });
    expect(dry.map((m) => [m.testId, m.replaced])).toEqual([
      ["tests__a", true],
      ["tests__b", false],
    ]);
    expect(readFileSync(recordingPath(tests, "tests__a"), "utf8")).toBe("main a");

    promoteBranch(tests, "feature/x");
    expect(readFileSync(recordingPath(tests, "tests__a"), "utf8")).toBe("branch a");
    expect(readFileSync(recordingPath(tests, "tests__b"), "utf8")).toBe("branch b");
    expect(existsSync(own)).toBe(false);
    expect(pendingBranches(tests)).toEqual([]);
    expect(promoteBranch(tests, "feature/x")).toEqual([]);
  });
});
