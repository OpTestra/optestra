import { brand } from "@optestra/brand";
import {
  type ExitPolicy,
  exitCodeFor,
  type FailureCause,
  type HealChange,
  needsRerecord,
  type Verdict,
} from "@optestra/contract";
import { buildModel, type RunData, type TestView } from "./model.js";

// The machine-readable summary for coding agents and other tools (EVD-4,
// AGT-3): per test, what happened, why, and where to look. Versioned like the
// contract: additive changes bump the minor, readers ignore unknown fields.

export const SUMMARY_VERSION = "1.2";
export const SUMMARY_KIND = "results-summary";

export interface SummaryCheck {
  attempt: number;
  checkId: string;
  stepIndex: number | null;
  kind: string;
  /** The expectation as the user wrote it. */
  expectation: string;
  /** Plain English: what the check verified. */
  description: string;
  expected: string | null;
  actual: string | null;
}

export interface SummaryStep {
  attempt: number;
  index: number;
  key: string;
  text: string;
  status: string;
  error: string | null;
}

export interface SummaryHeal {
  id: string;
  stepIndex: number;
  stepKey: string;
  changes: HealChange[];
  confidence: number;
  classification: string;
  status: string;
  policy: string;
  signals: { name: string; score: number; detail: string }[];
  /** 1.1: fallback | refind (no AI) | fixer (AI); null when unknown. */
  level: string | null;
  /** 1.1: auto | human once applied to the recording. */
  appliedBy: string | null;
  reviewedAt: string | null;
  /** 1.1 (HEAL-6): "the app's behaviour may have changed — check before accepting". */
  behaviourChange: boolean;
  /** 1.1: the recording diff, as text. */
  diff: string;
}

export interface SummaryTest {
  testId: string;
  name: string;
  /** The test file, relative to the project. */
  file: string;
  tags: string[];
  matrix: string | null;
  verdict: Verdict;
  cause: FailureCause | null;
  headline: string | null;
  blocked: { reason: string; message: string } | null;
  failingCheck: SummaryCheck | null;
  failingStep: SummaryStep | null;
  softWarnings: SummaryCheck[];
  heals: SummaryHeal[];
  /** 1.1 (HEAL-7): the test healed this often lately; re-record it with `command`. */
  rerecord: { healed: number; runs: number; command: string } | null;
  /** Relative to the run folder. */
  screenshot: string | null;
  durationMs: number;
  attempts: number;
  ai: { calls: number; costUsd: number; recent: { runs: number; calls: number } | null };
  /** The test's result document, relative to the run folder. */
  result: string;
  /** 1.2 (DIA-5): muted until a date: the verdict doesn't count toward exitCode. */
  muted: { reason: string; until: string } | null;
  /** 1.2: its mute ended before this run (it counts again). */
  muteExpired: { reason: string; until: string } | null;
  /** 1.2: looks flaky: muting is suggested (never done). */
  muteSuggested: { reason: string; confidence: number } | null;
}

export interface ResultsSummary {
  kind: typeof SUMMARY_KIND;
  version: string;
  contractVersion: string;
  runId: string;
  project: string;
  environment: string | null;
  target: string;
  trigger: string;
  mode: string;
  startedAt: string;
  durationMs: number;
  git: { branch: string | null; commit: string | null; pr: number | null } | null;
  blocked: { reason: string; message: string } | null;
  /** CLI-5 exit code under the given policy. */
  exitCode: number;
  totals: { tests: number } & Record<Verdict, number>;
  cost: { usd: number; unpricedCalls: number; aiCalls: number; subscriptionCalls: number };
  /** Failed, flaky and blocked tests grouped by what went wrong (DIA-4). */
  failureGroups: { headline: string; cause: FailureCause | null; tests: string[] }[];
  tests: SummaryTest[];
}

function checkOf(ref: TestView["failingCheck"]): SummaryCheck | null {
  if (!ref) return null;
  const { check } = ref;
  return {
    attempt: ref.attempt,
    checkId: check.id,
    stepIndex: check.stepIndex,
    kind: check.kind,
    expectation: check.expectation,
    description: check.generated.description,
    expected: check.expected,
    actual: check.actual,
  };
}

function testOf(test: TestView, cliName: string): SummaryTest {
  const step = test.failingStep;
  const recent = test.result?.recentHeals;
  return {
    testId: test.ref.testId,
    name: test.name,
    file: test.file,
    tags: [...test.tags],
    matrix: test.matrix,
    verdict: test.verdict,
    cause: test.cause,
    headline: test.headline,
    blocked: test.blocked,
    failingCheck: checkOf(test.failingCheck),
    failingStep: step
      ? {
          attempt: step.attempt,
          index: step.step.index,
          key: step.step.key,
          text: step.step.text,
          status: step.step.status,
          error: step.step.error,
        }
      : null,
    softWarnings: test.softWarnings.map((w) => checkOf(w) as SummaryCheck),
    heals: test.heals.map((heal) => ({
      id: heal.id,
      stepIndex: heal.stepIndex,
      stepKey: heal.stepKey,
      changes: heal.changes.map((c) => ({ ...c })),
      confidence: heal.confidence,
      classification: heal.classification,
      status: heal.status,
      policy: heal.policy,
      signals: heal.signals.map((s) => ({ name: s.name, score: s.score, detail: s.detail })),
      level: heal.level ?? null,
      appliedBy: heal.appliedBy ?? null,
      reviewedAt: heal.reviewedAt ?? null,
      behaviourChange: heal.classification === "behavior_change",
      diff: heal.diff,
    })),
    rerecord:
      recent && needsRerecord(recent)
        ? {
            healed: recent.healed,
            runs: recent.runs,
            command: `${cliName} run ${test.file} --rerecord`,
          }
        : null,
    screenshot: test.screenshot,
    durationMs: test.ref.durationMs,
    attempts: test.ref.attempts,
    ai: {
      calls: test.ref.aiCalls,
      costUsd: test.ref.costUsd,
      recent: test.result?.ai.recent ?? null,
    },
    result: test.ref.result,
    muted: test.muted ? { reason: test.muted.reason, until: test.muted.until } : null,
    muteExpired: test.muteExpired
      ? { reason: test.muteExpired.reason, until: test.muteExpired.until }
      : null,
    muteSuggested: test.muteSuggested
      ? { reason: test.muteSuggested.reason, confidence: test.muteSuggested.confidence }
      : null,
  };
}

export function buildResultsSummary(
  data: RunData,
  policy: ExitPolicy = { healedCountsAsPass: false },
  cliName: string = brand.cliName,
): ResultsSummary {
  const model = buildModel(data);
  const { run } = model;
  return {
    kind: SUMMARY_KIND,
    version: SUMMARY_VERSION,
    contractVersion: run.contractVersion,
    runId: run.runId,
    project: run.project,
    environment: run.environment,
    target: run.target,
    trigger: run.trigger,
    mode: run.mode,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    git: run.git,
    blocked: run.blocked,
    exitCode: exitCodeFor(run, policy),
    totals: { ...run.totals },
    cost: {
      usd: run.cost.usd,
      unpricedCalls: run.cost.unpricedCalls,
      aiCalls: run.cost.aiCalls,
      subscriptionCalls: model.subscriptionCalls,
    },
    failureGroups: model.groups.map((g) => ({
      headline: g.headline,
      cause: g.cause,
      tests: g.tests.map((t) => t.ref.testId),
    })),
    tests: model.tests.map((test) => testOf(test, cliName)),
  };
}

/** The summary as pretty-printed JSON with a trailing newline. */
export function renderJsonSummary(data: RunData, policy?: ExitPolicy, cliName?: string): string {
  return `${JSON.stringify(buildResultsSummary(data, policy, cliName), null, 2)}\n`;
}

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;
const count = { type: "integer", minimum: 0 } as const;
const ms = { type: "number", minimum: 0 } as const;
const usd = { type: "number", minimum: 0 } as const;
const unit = { type: "number", minimum: 0, maximum: 1 } as const;
const VERDICT_ENUM = ["passed", "healed", "failed", "flaky", "blocked"];
const CAUSE_ENUM = ["product_bug", "test_drift", "environment", "test_data", "blocked", null];

const obj = (properties: Record<string, unknown>, description?: string) => ({
  type: "object",
  ...(description ? { description } : {}),
  required: Object.keys(properties),
  properties,
});

const blockedSchema = {
  oneOf: [{ type: "null" }, obj({ reason: str, message: str })],
};

const checkSchema = obj(
  {
    attempt: { type: "integer", minimum: 1 },
    checkId: str,
    stepIndex: { type: ["integer", "null"], minimum: 0 },
    kind: str,
    expectation: { ...str, description: "The expectation as the user wrote it." },
    description: { ...str, description: "Plain English: what the check verified." },
    expected: nullableStr,
    actual: nullableStr,
  },
  "A check result.",
);

/** JSON Schema (draft 2020-12) of the results summary. Objects allow extra properties. */
export function resultsSummaryJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Results summary",
    description: `Machine-readable summary of one run, version ${SUMMARY_VERSION}. Additive changes bump the minor version; readers ignore unknown fields.`,
    ...obj({
      kind: { const: SUMMARY_KIND },
      version: { type: "string", pattern: "^1\\.\\d+$" },
      contractVersion: { type: "string", pattern: "^\\d+\\.\\d+$" },
      runId: str,
      project: str,
      environment: nullableStr,
      target: str,
      trigger: str,
      mode: str,
      startedAt: { type: "string", format: "date-time" },
      durationMs: ms,
      git: {
        oneOf: [
          { type: "null" },
          obj({ branch: nullableStr, commit: nullableStr, pr: { type: ["integer", "null"] } }),
        ],
      },
      blocked: blockedSchema,
      exitCode: { enum: [0, 1, 2], description: "0 passed, 1 failures, 2 blocked or empty." },
      totals: obj({
        tests: count,
        passed: count,
        healed: count,
        failed: count,
        flaky: count,
        blocked: count,
      }),
      cost: obj({ usd, unpricedCalls: count, aiCalls: count, subscriptionCalls: count }),
      failureGroups: {
        type: "array",
        items: obj({
          headline: str,
          cause: { enum: CAUSE_ENUM },
          tests: { type: "array", items: str, minItems: 1 },
        }),
      },
      tests: {
        type: "array",
        items: obj({
          testId: str,
          name: str,
          file: { ...str, description: "The test file, relative to the project." },
          tags: { type: "array", items: str },
          matrix: nullableStr,
          verdict: { enum: VERDICT_ENUM },
          cause: { enum: CAUSE_ENUM },
          headline: nullableStr,
          blocked: blockedSchema,
          failingCheck: { oneOf: [{ type: "null" }, checkSchema] },
          failingStep: {
            oneOf: [
              { type: "null" },
              obj({
                attempt: { type: "integer", minimum: 1 },
                index: count,
                key: str,
                text: str,
                status: str,
                error: nullableStr,
              }),
            ],
          },
          softWarnings: { type: "array", items: checkSchema },
          heals: {
            type: "array",
            items: obj({
              id: str,
              stepIndex: count,
              stepKey: str,
              changes: {
                type: "array",
                minItems: 1,
                items: {
                  ...obj({
                    target: { enum: ["locator", "action", "wait"] },
                    before: str,
                    after: str,
                  }),
                  additionalProperties: false,
                },
              },
              confidence: unit,
              classification: str,
              status: str,
              policy: str,
              signals: {
                type: "array",
                items: obj({ name: str, score: unit, detail: str }),
              },
              level: { enum: ["fallback", "refind", "fixer", null] },
              appliedBy: { enum: ["auto", "human", null] },
              reviewedAt: nullableStr,
              behaviourChange: { type: "boolean" },
              diff: str,
            }),
          },
          rerecord: {
            oneOf: [{ type: "null" }, obj({ healed: count, runs: count, command: str })],
          },
          screenshot: { ...nullableStr, description: "Relative to the run folder." },
          durationMs: ms,
          attempts: count,
          ai: obj({
            calls: count,
            costUsd: usd,
            recent: { oneOf: [{ type: "null" }, obj({ runs: count, calls: count })] },
          }),
          result: {
            ...str,
            description: "The test's result document, relative to the run folder.",
          },
          muted: {
            description: "1.2 (DIA-5): muted until a date; its verdict doesn't count.",
            oneOf: [{ type: "null" }, obj({ reason: str, until: str })],
          },
          muteExpired: { oneOf: [{ type: "null" }, obj({ reason: str, until: str })] },
          muteSuggested: { oneOf: [{ type: "null" }, obj({ reason: str, confidence: unit })] },
        }),
      },
    }),
  };
}
