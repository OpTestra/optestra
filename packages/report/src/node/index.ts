import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { brand } from "@testament/brand";
import { isUlid, RUN_FILE, RUNS_DIR, withHealReview } from "@testament/contract";
import { type ReadDiagnostic, readHealReview, readRun } from "@testament/contract/node";
import { type HtmlReportOptions, renderHtmlReport } from "../html/render.js";
import type { RunData } from "../model.js";

export { openFile } from "./open.js";

export type LoadRunResult =
  | { ok: true; data: RunData; diagnostics: ReadDiagnostic[] }
  | { ok: false; diagnostics: ReadDiagnostic[] };

/**
 * Reads a run folder for rendering. Fails only when run.json can't be read;
 * other problems (a missing artifact, one unreadable result) are kept as
 * diagnostics and shown in the report.
 */
export function loadRunData(runDir: string): LoadRunResult {
  const { run, tests: read, diagnostics } = readRun(runDir);
  if (!run) return { ok: false, diagnostics };
  // Heal decisions made after the run (HEAL-4) are shown on the proposals.
  const review = readHealReview(runDir);
  const tests = read.map((test) => withHealReview(test, review));
  return { ok: true, data: { run, tests, diagnostics }, diagnostics };
}

/** Writes a file atomically (temp file + rename), creating its folder. */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

export const REPORT_FILE = "index.html";

export interface WriteReportOptions extends Omit<HtmlReportOptions, "artifactBase"> {
  /** Folder to write index.html into. Default: the run folder. */
  outDir?: string;
}

/** Renders and writes `index.html`; artifact links stay relative to the run folder. Returns its path. */
export function writeHtmlReport(
  runDir: string,
  data: RunData,
  options: WriteReportOptions = {},
): string {
  const outDir = resolve(options.outDir ?? runDir);
  const fromOut = relative(outDir, resolve(runDir));
  // On Windows a run folder on another drive has no relative path: link by file URL instead.
  const base = isAbsolute(fromOut)
    ? pathToFileURL(resolve(runDir)).href
    : fromOut.split(sep).join("/");
  const path = join(outDir, REPORT_FILE);
  const { productName, cliName, tokens } = options;
  writeFileAtomic(
    path,
    renderHtmlReport(data, {
      artifactBase: base,
      ...(productName ? { productName } : {}),
      ...(cliName ? { cliName } : {}),
      ...(tokens ? { tokens } : {}),
    }),
  );
  return path;
}

/** `<projectDir>/<data dir>/runs`. */
export function runsDir(projectDir: string): string {
  return join(projectDir, brand.dataDirName, RUNS_DIR);
}

/** The newest finished run folder (ULID names sort by time), or undefined. */
export function latestRunDir(projectDir: string): string | undefined {
  const dir = runsDir(projectDir);
  if (!existsSync(dir)) return undefined;
  const newest = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isUlid(e.name) && existsSync(join(dir, e.name, RUN_FILE)))
    .map((e) => e.name)
    .sort()
    .at(-1);
  return newest ? join(dir, newest) : undefined;
}

/**
 * Colour only on a TTY, never when NO_COLOR is set or TERM is dumb;
 * FORCE_COLOR (not "0") turns it on.
 */
export function shouldUseColor(
  stream: { isTTY?: boolean },
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  return stream.isTTY === true && env.TERM !== "dumb";
}
