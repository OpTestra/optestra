import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brand } from "@testament/brand";
import { type ParsedRecording, parseRecording, serializeRecording } from "../serialize.js";
import type { Recording } from "../schema.js";

/** `<tests dir>/<data dir>/<testId>.steps.json` (data dir from brand): committed next to the tests (REP-1). */
export function recordingPath(testsDir: string, testId: string): string {
  return join(testsDir, brand.dataDirName, `${testId}.steps.json`);
}

/** Reads a recording; `undefined` when the file doesn't exist. Never throws on bad content. */
export function readRecording(file: string): ParsedRecording | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return parseRecording(text);
}

/** Writes a recording atomically in its stable form. */
export function writeRecording(file: string, recording: Recording): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, serializeRecording(recording));
  renameSync(temp, file);
}
