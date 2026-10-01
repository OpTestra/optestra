import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { brand } from "@optestra/brand";
import { recordingPath } from "./index.js";

// Branch-aware recordings (REP-8). On a feature branch of a GitHub project,
// recordings the engine writes (authoring, healing, accepted fixes) go to
// `<tests>/<data dir>/branches/<branch>/`, so main's stay as they are until the
// branch merges; runs prefer the branch's recording and fall back to main's.
// After the merge, `recordings promote` moves the branch's files into place.
// With no git (or `recordings.branches: off`) everything is as before.

export const BRANCHES_DIR = "branches";

/** The branch being worked on, when it isn't the main one. */
export interface RecordingBranch {
  name: string;
  /** Where the name came from. */
  source: "env" | "github" | "git";
}

/** Folder-safe name of a branch: `feature/discounts` → `feature--discounts`. */
export function branchSlug(branch: string): string {
  return (
    branch
      .replaceAll("/", "--")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+/, "")
      .slice(0, 120) || "branch"
  );
}

/** `<tests dir>/<data dir>/branches/<branch>/` */
export function branchDir(testsDir: string, branch: string): string {
  return join(testsDir, brand.dataDirName, BRANCHES_DIR, branchSlug(branch));
}

/** Where a test's recording is read from and written to on `branch` (null: main's). */
export function recordingFiles(
  testsDir: string,
  testId: string,
  branch: RecordingBranch | null | undefined,
): { read: string; write: string; fromBranch: boolean } {
  const main = recordingPath(testsDir, testId);
  if (!branch) return { read: main, write: main, fromBranch: false };
  const own = join(branchDir(testsDir, branch.name), `${testId}.steps.json`);
  const fromBranch = existsSync(own);
  return { read: fromBranch ? own : main, write: own, fromBranch };
}

// ── detection ────────────────────────────────────────────────────────────────

/** The repository's git folders (a worktree's own and the common one), or null. */
function gitDirs(start: string): { git: string; common: string } | null {
  try {
    let dir = resolve(start);
    while (!existsSync(join(dir, ".git"))) {
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
    let git = join(dir, ".git");
    if (statSync(git).isFile()) {
      const pointer = readFileSync(git, "utf8")
        .match(/^gitdir:\s*(.+)$/m)?.[1]
        ?.trim();
      if (!pointer) return null;
      git = isAbsolute(pointer) ? pointer : resolve(dir, pointer);
    }
    const common = existsSync(join(git, "commondir"))
      ? resolve(git, readFileSync(join(git, "commondir"), "utf8").trim())
      : git;
    return { git, common };
  } catch {
    return null;
  }
}

/** The checked-out branch, read from .git (git isn't run); null when detached or no git. */
export function gitBranch(start: string): string | null {
  const dirs = gitDirs(start);
  if (!dirs) return null;
  try {
    const head = readFileSync(join(dirs.git, "HEAD"), "utf8").trim();
    return head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Whether the repository has a GitHub remote (its .git/config names github.com). */
export function hasGitHubRemote(start: string): boolean {
  const dirs = gitDirs(start);
  if (!dirs) return false;
  try {
    return /^\s*url\s*=\s*\S*github\.com[:/]/m.test(
      readFileSync(join(dirs.common, "config"), "utf8"),
    );
  } catch {
    return false;
  }
}

const ENV_BRANCH = `${brand.cliName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BRANCH`;

/**
 * The branch a run is on: `<PREFIX>_BRANCH`, then the GitHub Action's
 * variables (a PR's head branch, else the pushed branch), then .git's HEAD.
 */
export function detectBranch(
  env: Readonly<Record<string, string | undefined>>,
  projectDir: string,
): RecordingBranch | null {
  const explicit = env[ENV_BRANCH]?.trim();
  if (explicit) return { name: explicit, source: "env" };
  const head = env.GITHUB_HEAD_REF?.trim();
  if (head) return { name: head, source: "github" };
  const ref = env.GITHUB_REF?.trim();
  if (ref?.startsWith("refs/heads/")) return { name: ref.slice(11), source: "github" };
  if (env.GITHUB_REF_TYPE === "branch" && env.GITHUB_REF_NAME?.trim())
    return { name: env.GITHUB_REF_NAME.trim(), source: "github" };
  const local = gitBranch(projectDir);
  return local ? { name: local, source: "git" } : null;
}

export interface BranchSettings {
  /** auto: on for GitHub projects (a github.com remote, or in a GitHub Action). */
  branches: "auto" | "on" | "off";
  /** The branch whose recordings are the main ones; not set: main or master. */
  mainBranch?: string | null | undefined;
}

/** The feature branch whose recordings this project uses, or null (main's, as before). */
export function recordingBranch(
  settings: BranchSettings,
  env: Readonly<Record<string, string | undefined>>,
  projectDir: string,
): RecordingBranch | null {
  if (settings.branches === "off") return null;
  if (
    settings.branches === "auto" &&
    env.GITHUB_ACTIONS !== "true" &&
    !env[ENV_BRANCH]?.trim() &&
    !hasGitHubRemote(projectDir)
  )
    return null;
  const branch = detectBranch(env, projectDir);
  if (!branch) return null;
  const main = settings.mainBranch ? [settings.mainBranch] : ["main", "master"];
  return main.includes(branch.name) ? null : branch;
}

// ── promote ──────────────────────────────────────────────────────────────────

export interface Promoted {
  testId: string;
  /** Project-relative-ready absolute paths. */
  from: string;
  to: string;
  /** Main had a recording for it, now replaced. */
  replaced: boolean;
}

/** The recordings a branch has, by test id. */
export function branchRecordings(testsDir: string, branch: string): string[] {
  const dir = branchDir(testsDir, branch);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".steps.json"))
    .map((name) => name.slice(0, -".steps.json".length))
    .sort();
}

/** Every branch with recordings waiting (folder names). */
export function pendingBranches(testsDir: string): string[] {
  const dir = join(testsDir, brand.dataDirName, BRANCHES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Moves a branch's recordings over main's (after the merge) and removes the
 * branch's folder. `dryRun` only says what would move.
 */
export function promoteBranch(
  testsDir: string,
  branch: string,
  options: { dryRun?: boolean } = {},
): Promoted[] {
  const dir = branchDir(testsDir, branch);
  const moved: Promoted[] = [];
  for (const testId of branchRecordings(testsDir, branch)) {
    const from = join(dir, `${testId}.steps.json`);
    const to = recordingPath(testsDir, testId);
    const replaced = existsSync(to);
    if (!options.dryRun) {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
    moved.push({ testId, from, to, replaced });
  }
  if (!options.dryRun && existsSync(dir)) {
    const left = readdirSync(dir).filter((name) => !name.endsWith(".tmp"));
    if (left.length === 0) rmSync(dir, { recursive: true, force: true });
  }
  return moved;
}
