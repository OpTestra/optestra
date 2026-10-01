import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { brand } from "@optestra/brand";
import type { EvidenceFile } from "@optestra/browser";
import { defaultRedactor } from "@optestra/config/node";
import { recordingPath, writeRecording } from "@optestra/recording/node";
import type { AuthoringReport, AuthorResult } from "./types.js";

export interface SaveOptions {
  projectDir: string;
  testsDir: string;
  result: AuthorResult;
  /** The harness's evidence files (already scrubbed). */
  evidence?: readonly Pick<EvidenceFile, "path">[];
  redact?: (text: string) => string;
}

export interface SavedAuthoring {
  recordingPath: string;
  reportDir: string;
  reportPath: string;
  report: AuthoringReport;
}

const posix = (path: string) => path.split(sep).join("/");

/**
 * Writes the recording next to the tests (`<tests>/<data dir>/<testId>.steps.json`)
 * and the report, screenshots and evidence to `<project>/<data dir>/authoring/<runId>/`.
 */
export function saveAuthoring(options: SaveOptions): SavedAuthoring {
  const redact = options.redact ?? ((text: string) => defaultRedactor.redact(text));
  const { result } = options;
  const file = recordingPath(options.testsDir, result.recording.testId);
  writeRecording(file, result.recording);

  const reportDir = join(options.projectDir, brand.dataDirName, "authoring", result.report.runId);
  mkdirSync(join(reportDir, "steps"), { recursive: true });
  for (const [path, bytes] of result.screenshots) writeFileSync(join(reportDir, path), bytes);
  const evidence: string[] = [];
  for (const item of options.evidence ?? []) {
    const name = basename(item.path);
    copyFileSync(item.path, join(reportDir, name));
    evidence.push(name);
  }
  const report: AuthoringReport = {
    ...result.report,
    recordingPath: posix(relative(options.projectDir, file)),
    evidence,
  };
  const reportPath = join(reportDir, "report.json");
  writeFileSync(reportPath, `${redact(JSON.stringify(report, null, 2))}\n`);
  return { recordingPath: file, reportDir, reportPath, report };
}
