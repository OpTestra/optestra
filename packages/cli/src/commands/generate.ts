import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { brand } from "@optestra/brand";
import { findProject, projectFile } from "@optestra/config/node";
import type { CommandIo } from "./config.js";

// `generate [tests…]`: writes the plain Playwright spec of every recorded test
// (LOOP-3), plus the shared fixtures and config, next to the recordings. Never
// overwrites a file changed by hand unless --force; --check only reports (CI).

export interface GenerateCommandOptions {
  env?: string;
  dir?: string;
  force?: boolean;
  check?: boolean;
}

const LABELS: Record<string, string> = {
  created: "created",
  updated: "updated",
  unchanged: "ok",
  stale: "stale",
  edited: "edited",
  overwritten: "replaced",
};

/** Exit 0: done (or up to date). 1: a file was edited by hand, or (--check) is stale. 2: project problem. */
export async function runGenerateCommand(
  tests: string[],
  options: GenerateCommandOptions,
  io: CommandIo,
): Promise<number> {
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  if (!existsSync(projectFile(dir))) {
    io.stdout(`No ${brand.configFileName} found. Run this inside a project, or pass --dir.\n`);
    return 2;
  }
  const { generateProject } = await import("@optestra/codegen/node");
  const result = await generateProject({
    projectDir: dir,
    tests,
    cwd: io.cwd,
    environment: options.env,
    env: io.env,
    force: options.force ?? false,
    check: options.check ?? false,
  });
  if (!result.ok) {
    for (const problem of result.problems) io.stdout(`error ${problem}\n`);
    return 2;
  }
  for (const file of result.files) {
    io.stdout(`  ${(LABELS[file.status] ?? file.status).padEnd(8)} ${file.path}\n`);
  }
  for (const skipped of result.skipped) {
    io.stdout(`  ${"skipped".padEnd(8)} ${skipped.test} (${skipped.reason})\n`);
  }
  const edited = result.files.filter((file) => file.status === "edited");
  const stale = result.files.filter((file) => file.status === "stale");
  if (edited.length > 0) {
    io.stdout(
      `\n${edited.length} file${edited.length === 1 ? " was" : "s were"} changed by hand and ${options.check ? "would not be" : "were not"} overwritten:\n${edited.map((file) => `  ${file.path}\n`).join("")}Keep your edits, or pass --force to replace ${edited.length === 1 ? "it" : "them"} with freshly generated code.\n`,
    );
  }
  if (options.check && stale.length > 0) {
    io.stdout(
      `\n${stale.length} generated file${stale.length === 1 ? " is" : "s are"} out of date. Run \`${brand.cliName} generate\`.\n`,
    );
  }
  if (result.files.length === 0 && result.skipped.length === 0) io.stdout("No tests found.\n");
  return edited.length > 0 || (options.check && stale.length > 0) ? 1 : 0;
}
