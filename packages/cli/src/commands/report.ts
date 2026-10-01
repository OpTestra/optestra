import { relative, resolve } from "node:path";
import { brand } from "@optestra/brand";
import { findProject } from "@optestra/config/node";
import { latestRunDir, loadRunData, openFile, writeHtmlReport } from "@optestra/report/node";
import type { CommandIo } from "./config.js";

export interface ReportCommandOptions {
  out?: string;
  open?: boolean;
  dir?: string;
}

/**
 * `report [runDir]`: writes the offline HTML report (EVD-2) into the run folder
 * or `--out`, for the given run or the project's latest. 0 written, 2 no run.
 */
export function runReportCommand(
  runDir: string | undefined,
  options: ReportCommandOptions,
  io: CommandIo & { open?: (path: string) => void },
): number {
  let dir: string | undefined;
  if (runDir) {
    dir = resolve(io.cwd, runDir);
  } else {
    const project = options.dir ? resolve(io.cwd, options.dir) : findProject(io.cwd);
    dir = project ? latestRunDir(project) : undefined;
    if (!dir) {
      io.stdout(
        project
          ? `No finished runs in ${relative(io.cwd, project) || "."}. Run the tests first, or pass a run folder.\n`
          : `Not inside a project (no ${brand.configFileName} found). Pass a run folder.\n`,
      );
      return 2;
    }
  }
  const loaded = loadRunData(dir);
  if (!loaded.ok) {
    const problems = loaded.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => `  ${d.file}${d.line ? `:${d.line}` : ""}  ${d.message}`);
    io.stdout(`Cannot read the run in ${runDir ?? dir}:\n${problems.join("\n")}\n`);
    return 2;
  }
  const path = writeHtmlReport(dir, loaded.data, {
    ...(options.out ? { outDir: resolve(io.cwd, options.out) } : {}),
  });
  const shown = relative(io.cwd, path);
  io.stdout(`Report written to ${shown.startsWith("..") ? path : shown}\n`);
  if (options.open) (io.open ?? openFile)(path);
  return 0;
}
