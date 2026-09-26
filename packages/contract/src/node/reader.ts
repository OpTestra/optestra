import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ArtifactRef } from "../common.js";
import { type Event, parseEvent } from "../events.js";
import { EVENTS_FILE, RUN_FILE, runLayout } from "../layout.js";
import { type Run, RunSchema } from "../run.js";
import { type TestResult, TestResultSchema } from "../test-result.js";
import { sha256 } from "./fs.js";

export interface ReadDiagnostic {
  severity: "error" | "warning" | "info";
  /** Relative to the run folder. */
  file: string;
  line?: number;
  message: string;
}

export interface ReadRunResult {
  /** Null when run.json is missing or invalid (for example a run still in progress). */
  run: Run | null;
  tests: TestResult[];
  /** Known events in order. Unknown types from newer versions are skipped with an info diagnostic. */
  events: Event[];
  diagnostics: ReadDiagnostic[];
}

export interface ReadRunOptions {
  /** Also check every artifact's sha256 (reads every file). Default false: existence and size only. */
  verifyArtifacts?: boolean;
}

function readJson(dir: string, file: string, diagnostics: ReadDiagnostic[]): unknown {
  const path = join(dir, file);
  if (!existsSync(path)) {
    diagnostics.push({ severity: "error", file, message: "missing" });
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    diagnostics.push({
      severity: "error",
      file,
      message: `not valid JSON: ${(error as Error).message}`,
    });
    return undefined;
  }
}

function validate<T>(
  schema: z.ZodType<T>,
  value: unknown,
  file: string,
  diagnostics: ReadDiagnostic[],
) {
  if (value === undefined) return null;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  diagnostics.push({ severity: "error", file, message: z.prettifyError(result.error) });
  return null;
}

/** Reads and validates a run folder. Never throws for bad content: problems become diagnostics. */
export function readRun(dir: string, options: ReadRunOptions = {}): ReadRunResult {
  const diagnostics: ReadDiagnostic[] = [];
  const run = validate(RunSchema, readJson(dir, RUN_FILE, diagnostics), RUN_FILE, diagnostics);

  const events: Event[] = [];
  const eventsPath = join(dir, EVENTS_FILE);
  if (existsSync(eventsPath)) {
    readFileSync(eventsPath, "utf8")
      .split("\n")
      .forEach((text, index) => {
        if (text.trim() === "") return;
        const line = index + 1;
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          diagnostics.push({
            severity: "error",
            file: EVENTS_FILE,
            line,
            message: "not valid JSON",
          });
          return;
        }
        const parsed = parseEvent(value);
        if (parsed.kind === "event") events.push(parsed.event);
        else if (parsed.kind === "unknown")
          diagnostics.push({
            severity: "info",
            file: EVENTS_FILE,
            line,
            message: `skipped unknown event type "${parsed.type}"`,
          });
        else
          diagnostics.push({ severity: "error", file: EVENTS_FILE, line, message: parsed.message });
      });
  } else {
    diagnostics.push({ severity: "warning", file: EVENTS_FILE, message: "missing" });
  }

  const resultFiles = run
    ? run.tests.map((t) => t.result)
    : existsSync(join(dir, "tests"))
      ? readdirSync(join(dir, "tests"))
          .map((testId) => runLayout.testResult(testId))
          .filter((file) => existsSync(join(dir, file)))
      : [];
  const tests: TestResult[] = [];
  for (const file of resultFiles) {
    const test = validate(TestResultSchema, readJson(dir, file, diagnostics), file, diagnostics);
    if (!test) continue;
    if (run && test.runId !== run.runId)
      diagnostics.push({
        severity: "error",
        file,
        message: `runId ${test.runId} does not match run.json`,
      });
    tests.push(test);
  }

  const artifacts: ArtifactRef[] = [
    ...(run?.artifacts ?? []),
    ...tests.flatMap((t) => t.attempts.flatMap((a) => a.artifacts)),
  ];
  for (const artifact of artifacts) {
    const path = join(dir, artifact.path);
    if (!existsSync(path)) {
      diagnostics.push({ severity: "error", file: artifact.path, message: "artifact missing" });
    } else if (statSync(path).size !== artifact.bytes) {
      diagnostics.push({
        severity: "error",
        file: artifact.path,
        message: `size is not ${artifact.bytes} bytes`,
      });
    } else if (options.verifyArtifacts && sha256(readFileSync(path)) !== artifact.sha256) {
      diagnostics.push({
        severity: "error",
        file: artifact.path,
        message: "sha256 does not match",
      });
    }
  }
  for (const test of tests)
    for (const attempt of test.attempts)
      for (const step of attempt.steps)
        for (const shot of [step.screenshots.before, step.screenshots.after])
          if (shot && !existsSync(join(dir, shot)))
            diagnostics.push({
              severity: "warning",
              file: shot,
              message: `screenshot of step ${step.index} missing`,
            });

  return { run, tests, events, diagnostics };
}
