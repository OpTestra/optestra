import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { brand } from "@optestra/brand";
import { findProject, loadProject, projectFile } from "@optestra/config/node";
import type { Command } from "commander";
import type { CommandIo } from "./config.js";

// `recordings promote` (REP-8): after a feature branch merges, move its
// recordings (`<tests>/<data dir>/branches/<branch>/`) over main's, so main's
// runs replay what the branch recorded. `recordings branches` lists the
// branches with recordings waiting.

export interface RecordingsCommandOptions {
  branch?: string;
  all?: boolean;
  dryRun?: boolean;
  json?: boolean;
  dir?: string;
}

const posix = (path: string) => path.split(sep).join("/");

/** Exit 0 done (or nothing to do), 2 no project or no branch to promote. */
export async function runRecordingsCommand(
  action: "promote" | "branches",
  options: RecordingsCommandOptions,
  io: CommandIo,
): Promise<number> {
  const fail = (message: string) => {
    io.stdout(options.json ? `${JSON.stringify({ error: message }, null, 2)}\n` : `${message}\n`);
    return 2;
  };
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  if (!existsSync(projectFile(dir)))
    return fail(`No project file found in ${dir}. Create one first (${brand.cliName} init).`);
  const loaded = loadProject(dir, { env: io.env });
  const testsDir = resolve(dir, loaded.config.tests?.dir ?? "tests");
  const recordings = await import("@optestra/recording/node");
  const waiting = recordings.pendingBranches(testsDir);

  if (action === "branches") {
    const rows = waiting.map((slug) => ({
      branch: slug,
      recordings: recordings.branchRecordings(testsDir, slug).length,
    }));
    if (options.json) io.stdout(`${JSON.stringify({ branches: rows }, null, 2)}\n`);
    else if (rows.length === 0) io.stdout("No branch recordings waiting.\n");
    else
      for (const r of rows)
        io.stdout(`  ${r.branch}  ${r.recordings} recording${r.recordings === 1 ? "" : "s"}\n`);
    return 0;
  }

  // Which branch: --branch, --all, or the one the run is on (a PR's head branch in the Action).
  let branches: string[];
  if (options.all) branches = waiting;
  else {
    const name = options.branch ?? recordings.detectBranch(io.env, dir)?.name;
    const main = loaded.config.recordings?.mainBranch;
    if (!name || (main ? name === main : ["main", "master"].includes(name)))
      return fail(
        `Which branch? Pass --branch <name> (the merged branch), or --all.${waiting.length ? ` Waiting: ${waiting.join(", ")}.` : ""}`,
      );
    branches = [recordings.branchSlug(name)];
  }
  const moved = branches.flatMap((slug) =>
    recordings
      .promoteBranch(testsDir, slug, { dryRun: options.dryRun === true })
      .map((m) => ({ branch: slug, ...m })),
  );
  const rows = moved.map((m) => ({
    branch: m.branch,
    test: m.testId,
    from: posix(relative(dir, m.from)),
    to: posix(relative(dir, m.to)),
    replaced: m.replaced,
  }));
  if (options.json) {
    io.stdout(`${JSON.stringify({ dryRun: options.dryRun === true, promoted: rows }, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    io.stdout(`No recordings to promote for ${branches.join(", ") || "any branch"}.\n`);
    return 0;
  }
  const verb = options.dryRun ? "Would promote" : "Promoted";
  io.stdout(`${verb} ${rows.length} recording${rows.length === 1 ? "" : "s"}:\n`);
  for (const r of rows)
    io.stdout(`  ${r.to}  ${r.replaced ? "replaced" : "new"} (from ${r.branch})\n`);
  if (!options.dryRun) io.stdout("\nCommit the moved files.\n");
  return 0;
}

export function registerRecordingsCommand(program: Command, io: () => CommandIo): void {
  const recordings = program
    .command("recordings")
    .description("per-branch recordings (feature branches of GitHub projects)");
  recordings
    .command("promote")
    .description("after a merge, move a branch's recordings over main's")
    .option("-b, --branch <name>", "the merged branch (default: the branch this runs on)")
    .option("--all", "every branch with recordings waiting")
    .option("--dry-run", "say what would move, move nothing")
    .option("--json", "print the result as JSON")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (options: RecordingsCommandOptions) => {
      process.exitCode = await runRecordingsCommand("promote", options, io());
    });
  recordings
    .command("branches")
    .description("list the branches with recordings waiting to be promoted")
    .option("--json", "print the list as JSON")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (options: RecordingsCommandOptions) => {
      process.exitCode = await runRecordingsCommand("branches", options, io());
    });
}
