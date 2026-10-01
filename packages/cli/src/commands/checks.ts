import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { hasErrors } from "@optestra/config";
import { findProject, loadProject, projectFile } from "@optestra/config/node";
import { testIdFromPath } from "@optestra/contract";
import { type CheckRecording, describeCheck, type Sanity } from "@optestra/recording";
import { readRecording, recordingBranch, recordingFiles } from "@optestra/recording/node";
import type { CommandIo } from "./config.js";

// `checks <test>`: what each Expect/Soft line of a test was compiled into
// (LOOP-2): the plain-English summary, the op, how it was made, its sanity test
// and how it did while authoring. Reads the recording only; runs nothing.

export interface ChecksCommandOptions {
  json?: boolean;
  dir?: string;
  env?: string;
}

const posix = (path: string) => path.split(sep).join("/");

function sanityText(sanity: Sanity | undefined): string {
  if (!sanity) return "not tested";
  const probe = (label: string, p: Sanity["empty"]) =>
    `${label} ${p.result === "failed" ? "fails (good)" : p.result === "passed" ? "PASSES" : `skipped${p.note ? ` (${p.note})` : ""}`}`;
  const verdict = sanity.provesNothing ? "PROVES NOTHING" : "ok";
  return `${verdict}: ${probe("empty page", sanity.empty)}; ${probe("before the action", sanity.before)}`;
}

function authoringText(check: CheckRecording): string {
  if (check.check.type === "pending") return "not compiled";
  if (check.failedAtAuthoring) {
    return `FAILED: expected ${JSON.stringify(check.failedAtAuthoring.expected)}, saw ${JSON.stringify(check.failedAtAuthoring.actual)}`;
  }
  return check.sanity ? "passed" : "not evaluated";
}

export async function runChecksCommand(
  file: string,
  options: ChecksCommandOptions,
  io: CommandIo,
): Promise<number> {
  const absolute = resolve(io.cwd, file);
  if (!existsSync(absolute)) {
    io.stdout(`No such test file: ${file}\n`);
    return 2;
  }
  const dir = options.dir
    ? resolve(io.cwd, options.dir)
    : (findProject(dirname(absolute)) ?? io.cwd);
  if (!existsSync(projectFile(dir))) {
    io.stdout(`No project file found for ${file}.\n`);
    return 2;
  }
  await import("@optestra/models"); // registers the models config section
  const loaded = loadProject(dir, { environment: options.env, env: io.env });
  if (hasErrors(loaded.diagnostics)) {
    for (const d of loaded.diagnostics.filter((d) => d.severity === "error")) {
      io.stdout(`error ${d.code}: ${d.message}\n  Fix: ${d.fix}\n`);
    }
    return 2;
  }
  const path = posix(relative(dir, absolute));
  const testsDir = resolve(dir, loaded.config.tests?.dir ?? "tests");
  const branch = recordingBranch(loaded.config.recordings ?? { branches: "auto" }, io.env, dir);
  const read = readRecording(recordingFiles(testsDir, testIdFromPath(path), branch).read);
  if (!read) {
    io.stdout(`${path} has no recording yet. Run \`author ${file}\` first.\n`);
    return 2;
  }
  if (!read.ok) {
    io.stdout(`The recording of ${path} can't be read: ${read.error}\n`);
    return 2;
  }
  const checks = read.recording.checks.map((check) => ({
    ...check,
    summary: check.summary ?? describeCheck(check.check),
  }));
  if (options.json) {
    io.stdout(`${JSON.stringify({ test: path, checks }, null, 2)}\n`);
    return 0;
  }
  io.stdout(`${path}: ${checks.length} check${checks.length === 1 ? "" : "s"}\n`);
  checks.forEach((check, index) => {
    const how =
      check.generatedBy === "rules" && check.rule ? `rules: ${check.rule}` : check.generatedBy;
    io.stdout(`\n${index + 1}. ${check.soft ? "Soft" : "Expect"}: ${check.text}\n`);
    io.stdout(`   ${check.summary}\n`);
    io.stdout(`   op:        ${JSON.stringify(check.check)}\n`);
    io.stdout(`   made by:   ${how}\n`);
    io.stdout(`   sanity:    ${sanityText(check.sanity)}\n`);
    io.stdout(`   authoring: ${authoringText(check)}\n`);
    if (check.problem) io.stdout(`   problem:   ${check.problem}\n`);
  });
  return 0;
}
