import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brand } from "@testament/brand";
import type { StepResult } from "@testament/contract";
import type { ExpandedTest } from "@testament/spec";
import type { ReplayEvent, ReplayResult } from "./types.js";

// Tests with ```ts code steps run through their generated Playwright spec
// (LOOP-3): the harness has no eval, by design. The spec is regenerated first
// when stale, run with Playwright Test (JSON reporter), and mapped into the
// contract: one step per English step, the verdict from Playwright's own
// assertions. No healing: a spec is plain code.

interface ReportStep {
  title: string;
  duration?: number;
  error?: { message?: string };
  steps?: ReportStep[];
}
interface ReportResult {
  status: string;
  duration?: number;
  error?: { message?: string };
  steps?: ReportStep[];
}
interface ReportSuite {
  specs?: Array<{ title: string; tests: Array<{ results: ReportResult[] }> }>;
  suites?: ReportSuite[];
}

export interface SpecTestOptions {
  projectDir: string;
  testPath: string;
  test: ExpandedTest;
  attempt: number;
  environment: string;
  env: Readonly<Record<string, string | undefined>>;
  emit: (event: ReplayEvent) => void;
  newId: () => string;
  headless: boolean;
  browser: "chromium" | "firefox" | "webkit";
}

const blockedResult = (attempt: number, reason: string, message: string): ReplayResult => ({
  attempt,
  status: "blocked",
  steps: [],
  checks: [],
  heals: [],
  failure: null,
  blocked: { reason, message, stepIndex: null },
  modelCalls: [],
  observations: {},
  authored: { steps: [], checks: [], model: null },
  chapters: [],
  needsAi: 0,
  healedWithoutAi: 0,
});

function run(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: null, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function runSpecTest(options: SpecTestOptions): Promise<ReplayResult> {
  const { projectDir, attempt } = options;
  const { generateAfterRecording } = await import("@testament/codegen/node");
  const generated = await generateAfterRecording(projectDir, options.testPath, {
    environment: options.environment,
    env: options.env,
  });
  for (const file of generated.files.filter((f) => f.status === "edited"))
    options.emit({
      type: "log",
      level: "warn",
      message: `${file.path} was changed by hand: it runs as it is (not regenerated).`,
    });
  const spec = generated.files.find((f) => f.test === options.testPath)?.path;
  if (!spec || !existsSync(join(projectDir, spec)))
    return blockedResult(
      attempt,
      "config_error",
      `${options.testPath} has code steps but no generated spec (record it first).`,
    );
  let cli: string;
  try {
    cli = createRequire(join(projectDir, "package.json")).resolve("@playwright/test/cli");
  } catch {
    return blockedResult(
      attempt,
      "config_error",
      `${options.testPath} has code steps, which run with Playwright Test: install @playwright/test in the project.`,
    );
  }
  const specDir = join(projectDir, dirname(spec));
  const out = mkdtempSync(join(tmpdir(), `${brand.cliName}-spec-`));
  const report = join(out, "report.json");
  const started = Date.now();
  try {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env))
      if (value !== undefined) env[key] = value;
    env.PLAYWRIGHT_JSON_OUTPUT_NAME = report;
    const result = await run(
      [
        cli,
        "test",
        "-c",
        specDir,
        spec.slice(spec.lastIndexOf("/") + 1),
        `--project=${options.browser}`,
        "--workers=1",
        "--retries=0",
        "--reporter=json",
        `--output=${join(out, "results")}`,
        ...(options.headless ? [] : ["--headed"]),
      ],
      projectDir,
      env,
    );
    let json: { suites?: ReportSuite[] };
    try {
      json = JSON.parse(readFileSync(report, "utf8"));
    } catch {
      return blockedResult(
        attempt,
        "config_error",
        `Playwright Test didn't run ${spec}: ${(result.stderr || result.stdout).slice(0, 500)}`,
      );
    }
    let found: ReportResult | undefined;
    const walk = (suite: ReportSuite) => {
      for (const s of suite.specs ?? []) found ??= s.tests[0]?.results.at(-1);
      for (const child of suite.suites ?? []) walk(child);
    };
    for (const suite of json.suites ?? []) walk(suite);
    if (!found)
      return blockedResult(attempt, "config_error", `Playwright Test found no test in ${spec}.`);
    return mapResult(options, found, Date.now() - started);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Playwright's result → contract steps: one per top-level test.step (an English step). */
function mapResult(options: SpecTestOptions, result: ReportResult, ms: number): ReplayResult {
  const { attempt, test } = options;
  const steps: StepResult[] = [];
  const top = (result.steps ?? []).filter((s) => !/^(Before|After) Hooks$/.test(s.title));
  let failedIndex: number | null = null;
  top.forEach((step, index) => {
    const failed = Boolean(step.error);
    if (failed && failedIndex === null) failedIndex = index;
    const item: StepResult = {
      index,
      key: test.steps[index]?.textKey ?? `spec-${index}`,
      text: step.title,
      kind: "exact",
      status:
        failedIndex !== null && index > failedIndex ? "skipped" : failed ? "failed" : "passed",
      recovery: "none",
      locator: null,
      postState: null,
      startedAt: new Date().toISOString(),
      durationMs: step.duration ?? 0,
      settledMs: null,
      screenshots: { before: null, after: null },
      error: step.error?.message?.split("\n")[0]?.slice(0, 500) ?? null,
      checkIds: [],
      modelCallIds: [],
      decisionIds: [],
      healIds: [],
    };
    steps.push(item);
    options.emit({ type: "step.finished", step: item });
  });
  const passed = result.status === "passed";
  if (!passed && failedIndex === null) {
    // Failed outside any step (a hook, a timeout): report it on a step of its own.
    failedIndex = steps.length;
    const item: StepResult = {
      index: steps.length,
      key: "spec",
      text: "the generated spec",
      kind: "exact",
      status: "failed",
      recovery: "none",
      locator: null,
      postState: null,
      startedAt: new Date().toISOString(),
      durationMs: ms,
      settledMs: null,
      screenshots: { before: null, after: null },
      error: (result.error?.message ?? result.status).split("\n")[0]?.slice(0, 500) ?? null,
      checkIds: [],
      modelCallIds: [],
      decisionIds: [],
      healIds: [],
    };
    steps.push(item);
    options.emit({ type: "step.finished", step: item });
  }
  const failed = failedIndex === null ? undefined : steps[failedIndex];
  return {
    attempt,
    status: passed ? "passed" : "failed",
    steps,
    checks: [],
    heals: [],
    failure:
      !passed && failed
        ? {
            decider: { kind: "step", attempt, stepIndex: failed.index },
            headline: `${failed.text}: ${failed.error ?? "failed"} (generated spec)`,
          }
        : null,
    blocked: null,
    modelCalls: [],
    observations: {},
    authored: { steps: [], checks: [], model: null },
    chapters: [],
    needsAi: 0,
    healedWithoutAi: 0,
  };
}
