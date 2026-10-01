import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { brand } from "@optestra/brand";
import { RUN_FILE } from "@optestra/contract";
import type { CommandIo } from "./config.js";

// `merge-runs <dirs…> --out <dir>` (CLI-3, CI-6): shard run folders → one run
// folder, then the same summary and exit code as `run`. A folder that is not a
// run itself is searched (two levels) for run folders, so the folder that
// `actions/download-artifact` fills with one subfolder per shard works as is.

export interface MergeRunsCommandOptions {
  out: string;
  healedPasses?: boolean;
  dir?: string;
}

const posix = (path: string) => path.split(sep).join("/");

/** The run folders in `dir`: itself, or its children, or their children. */
export function findRunFolders(dir: string, depth = 2): string[] {
  if (existsSync(join(dir, RUN_FILE))) return [dir];
  if (depth === 0 || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => findRunFolders(join(dir, name), depth - 1));
}

export async function runMergeRunsCommand(
  dirs: string[],
  options: MergeRunsCommandOptions,
  io: CommandIo & { color?: boolean },
): Promise<number> {
  const out = resolve(io.cwd, options.out);
  const folders = [...new Set(dirs.flatMap((dir) => findRunFolders(resolve(io.cwd, dir))))].filter(
    (dir) => dir !== out,
  );
  if (folders.length === 0) {
    io.stdout(`No run folders (with ${RUN_FILE}) found in ${dirs.join(", ")}.\n`);
    return 2;
  }
  const { mergeRuns } = await import("@optestra/contract/node");
  const { exitCodeFor } = await import("@optestra/contract");
  let merged: ReturnType<typeof mergeRuns>;
  try {
    merged = mergeRuns(folders, out);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    io.stdout(`Could not merge: ${error.message}\n`);
    return 2;
  }

  // Healed counts as passed only when the project's heal policy is `auto` (CLI-5).
  let healedCountsAsPass = options.healedPasses ?? false;
  if (!healedCountsAsPass) {
    const { findProject, loadProject, projectFile } = await import("@optestra/config/node");
    const project = options.dir ? resolve(io.cwd, options.dir) : findProject(io.cwd);
    if (project && existsSync(projectFile(project)))
      healedCountsAsPass = loadProject(project, { env: io.env }).config.run.healPolicy === "auto";
  }
  const exitCode = exitCodeFor(merged.run, { healedCountsAsPass });
  const { formatRunSummary } = await import("@optestra/report");
  const near = relative(io.cwd, out);
  const where = near.startsWith("..") ? posix(out) : posix(near) || ".";
  const shards = merged.shards.map((s) => `  ${posix(s.dir)}: ${s.tests} tests`).join("\n");
  io.stdout(
    `Merged ${merged.shards.length} run folders:\n${shards}\n\n${formatRunSummary(
      { run: merged.run, tests: merged.tests },
      { color: io.color ?? false },
    )}\n  Results: ${where} (${brand.cliName} results ${where}, ${brand.cliName} report ${where})\n  exit code ${exitCode}\n`,
  );
  return exitCode;
}
