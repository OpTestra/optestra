import {
  type Attempt,
  type CheckResult,
  type DecisionRecord,
  type FailureCause,
  type HealProposal,
  type MatrixEntry,
  type ModelCall,
  type RecoveryLevel,
  type Run,
  type RunTestRef,
  type StepResult,
  type TestResult,
  VERDICTS,
  type Verdict,
} from "@testament/contract";

// One read of a run, shared by every output. Pure functions of the contract
// documents: nothing here looks at artifact contents, logs or events, so no
// output can carry a value the documents don't (guarantee 4).

/** A run folder's documents, as `readRun` returns them. */
export interface RunData {
  run: Run;
  tests: readonly TestResult[];
  /** Problems found while reading, shown in the HTML report. */
  diagnostics?: readonly { severity: string; file: string; line?: number; message: string }[];
}

export interface FailingCheck {
  attempt: number;
  check: CheckResult;
}

export interface FailingStep {
  attempt: number;
  step: StepResult;
}

export type EvidenceView =
  | { kind: "check"; attempt: number; check: CheckResult }
  | { kind: "step"; attempt: number; step: StepResult }
  | { kind: "decision"; attempt: number; decision: DecisionRecord }
  | { kind: "artifact"; path: string };

export interface TestView {
  ref: RunTestRef;
  /** Null when the result document could not be read. */
  result: TestResult | null;
  /** HTML id, unique in the report. */
  anchor: string;
  verdict: Verdict;
  name: string;
  file: string;
  tags: readonly string[];
  matrix: string | null;
  cause: FailureCause | null;
  /** The one line that matters (DIA-3), always set for failed, flaky and blocked tests. */
  headline: string | null;
  /** The attempt that explains the verdict: the failed one for flaky, else the last. */
  focusAttempt: Attempt | null;
  failingCheck: FailingCheck | null;
  failingStep: FailingStep | null;
  blocked: { reason: string; message: string } | null;
  /** The failure's screenshot, relative to the run folder. */
  screenshot: string | null;
  evidence: EvidenceView[];
  /** Soft checks that did not pass in the final attempt: warnings, never failures (VER-3). */
  softWarnings: FailingCheck[];
  /** Heal proposals of the final attempt (HEAL-4, HEAL-6). */
  heals: HealProposal[];
  modelCalls: ModelCall[];
}

export interface FailureGroup {
  id: string;
  headline: string;
  cause: FailureCause | null;
  /** Blocked reason, for blocked groups. */
  reason: string | null;
  tests: TestView[];
}

export interface ReportModel {
  run: Run;
  tests: TestView[];
  /** Failed, flaky and blocked tests, grouped by what went wrong (DIA-4). Largest first. */
  groups: FailureGroup[];
  heals: { test: TestView; heal: HealProposal }[];
  softWarnings: { test: TestView; warning: FailingCheck }[];
  /** Model calls paid by the user's own AI plan (MOD-6). */
  subscriptionCalls: number;
  tags: string[];
  diagnostics: NonNullable<RunData["diagnostics"]>;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  passed: "Passed",
  healed: "Healed",
  failed: "Failed",
  flaky: "Flaky",
  blocked: "Blocked",
};

export const CAUSE_LABEL: Record<FailureCause, string> = {
  product_bug: "Product bug",
  test_drift: "Test drift",
  environment: "Environment",
  test_data: "Test data",
  blocked: "Blocked",
};

export const RECOVERY_LABEL: Record<RecoveryLevel, string> = {
  replay: "replayed",
  refind: "re-found without AI",
  fixer: "fixed by AI",
  none: "—",
};

export { VERDICTS };

/** "chromium", "webkit · iPhone 15", "Android 14 · Pixel 8". */
export function matrixLabel(matrix: MatrixEntry): string {
  if (matrix.target === "web")
    return matrix.device ? `${matrix.browser} · ${matrix.device}` : matrix.browser;
  return `Android ${matrix.androidVersion} · ${matrix.device}`;
}

/** Human words for a snake_case enum value: "missing_secret" → "missing secret". */
export function words(value: string): string {
  return value.replace(/_/g, " ");
}

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

function allChecks(test: TestResult, attempt: number): CheckResult[] {
  return test.attempts.find((a) => a.attempt === attempt)?.checks ?? [];
}

function findStep(test: TestResult, attempt: number, index: number): StepResult | undefined {
  return test.attempts.find((a) => a.attempt === attempt)?.steps.find((s) => s.index === index);
}

function focusOf(test: TestResult): Attempt | null {
  if (test.verdict === "flaky")
    return test.attempts.findLast((a) => a.status !== "passed") ?? test.attempts.at(-1) ?? null;
  return test.attempts.at(-1) ?? null;
}

function failingCheckOf(test: TestResult): FailingCheck | null {
  for (const decider of [...test.decidedBy].reverse()) {
    if (decider.kind !== "check") continue;
    const check = allChecks(test, decider.attempt).find((c) => c.id === decider.checkId);
    if (check && !check.passed && !check.soft) return { attempt: decider.attempt, check };
  }
  if (test.verdict === "passed" || test.verdict === "healed") return null;
  const focus = focusOf(test);
  const check = focus?.checks.find((c) => !c.passed && !c.soft);
  return focus && check ? { attempt: focus.attempt, check } : null;
}

function failingStepOf(test: TestResult, check: FailingCheck | null): FailingStep | null {
  if (test.verdict === "passed" || test.verdict === "healed") return null;
  for (const decider of [...test.decidedBy].reverse()) {
    if (decider.kind !== "step") continue;
    const step = findStep(test, decider.attempt, decider.stepIndex);
    if (step && step.status !== "passed") return { attempt: decider.attempt, step };
  }
  if (check && check.check.stepIndex !== null) {
    const step = findStep(test, check.attempt, check.check.stepIndex);
    if (step) return { attempt: check.attempt, step };
  }
  const focus = focusOf(test);
  const step = focus?.steps.find((s) => s.status === "failed" || s.status === "blocked");
  return focus && step ? { attempt: focus.attempt, step } : null;
}

function evidenceOf(test: TestResult): EvidenceView[] {
  const out: EvidenceView[] = [];
  for (const ref of test.failureEvidence) {
    if (ref.kind === "artifact") {
      out.push({ kind: "artifact", path: ref.path });
      continue;
    }
    const attempt = test.attempts.find((a) => a.attempt === ref.attempt);
    if (ref.kind === "check") {
      const check = attempt?.checks.find((c) => c.id === ref.checkId);
      if (check) out.push({ kind: "check", attempt: ref.attempt, check });
    } else if (ref.kind === "step") {
      const step = attempt?.steps.find((s) => s.index === ref.stepIndex);
      if (step) out.push({ kind: "step", attempt: ref.attempt, step });
    } else {
      const decision = attempt?.decisions.find((d) => d.id === ref.decisionId);
      if (decision) out.push({ kind: "decision", attempt: ref.attempt, decision });
    }
  }
  return out;
}

/** "Expected '$90.00', found '$100.00'" from a failing check. */
export function checkLine(check: CheckResult): string {
  if (check.expected !== null && check.actual !== null)
    return `Expected ${check.expected}, found ${check.actual}`;
  if (check.expected !== null) return `Expected ${check.expected}`;
  return `Check failed: ${check.generated.description}`;
}

function viewOf(ref: RunTestRef, result: TestResult | null, anchor: string): TestView {
  const blockedDecider = result?.decidedBy.find((d) => d.kind === "blocked");
  const blocked = blockedDecider?.kind === "blocked" ? blockedDecider : null;
  const failingCheck = result ? failingCheckOf(result) : null;
  const failingStep = result ? failingStepOf(result, failingCheck) : null;
  const focusAttempt = result ? focusOf(result) : null;
  const last = result?.attempts.at(-1);
  const evidence = result ? evidenceOf(result) : [];
  const failing = ref.verdict === "failed" || ref.verdict === "flaky" || ref.verdict === "blocked";

  let headline = result?.headline ?? ref.headline;
  if (!headline && failing) {
    if (failingCheck) headline = checkLine(failingCheck.check);
    else if (failingStep?.step.error) headline = failingStep.step.error;
    else if (blocked) headline = `Blocked: ${blocked.message}`;
    else headline = `${VERDICT_LABEL[ref.verdict]} with no recorded reason`;
  }

  let screenshot: string | null = null;
  if (failing) {
    screenshot =
      evidence.flatMap((e) => (e.kind === "artifact" && IMAGE.test(e.path) ? [e.path] : []))[0] ??
      failingStep?.step.screenshots.after ??
      failingStep?.step.screenshots.before ??
      focusAttempt?.steps.findLast((s) => s.screenshots.after)?.screenshots.after ??
      null;
  }

  return {
    ref,
    result,
    anchor,
    verdict: ref.verdict,
    name: result?.name ?? ref.name,
    file: result?.file ?? ref.file,
    tags: result?.tags ?? [],
    matrix: result ? matrixLabel(result.matrix) : null,
    cause: result?.failureCause ?? null,
    headline,
    focusAttempt,
    failingCheck,
    failingStep,
    blocked: blocked ? { reason: blocked.reason, message: blocked.message } : null,
    screenshot,
    evidence,
    softWarnings: (last?.checks ?? [])
      .filter((c) => c.soft && !c.passed)
      .map((check) => ({ attempt: last?.attempt ?? 1, check })),
    heals: last?.heals ?? [],
    modelCalls: result?.attempts.flatMap((a) => a.modelCalls) ?? [],
  };
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

function groupKey(test: TestView): string {
  if (test.blocked) return `blocked|${test.blocked.reason}|${normalize(test.blocked.message)}`;
  return `${test.cause ?? "unknown"}|${normalize(test.headline ?? "")}`;
}

/** Makes a string safe and unique as an HTML id. */
function anchorFor(testId: string, used: Set<string>): string {
  const base = `test-${testId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  let anchor = base;
  for (let n = 2; used.has(anchor); n++) anchor = `${base}-${n}`;
  used.add(anchor);
  return anchor;
}

export function buildModel(data: RunData): ReportModel {
  const { run } = data;
  const results = new Map(data.tests.map((t) => [t.testId, t]));
  const used = new Set<string>();
  const tests = run.tests.map((ref) =>
    viewOf(ref, results.get(ref.testId) ?? null, anchorFor(ref.testId, used)),
  );

  const byKey = new Map<string, FailureGroup>();
  for (const test of tests) {
    if (test.verdict !== "failed" && test.verdict !== "flaky" && test.verdict !== "blocked")
      continue;
    const key = groupKey(test);
    let group = byKey.get(key);
    if (!group) {
      group = {
        id: `group-${byKey.size + 1}`,
        headline: test.headline ?? "",
        cause: test.cause,
        reason: test.blocked?.reason ?? null,
        tests: [],
      };
      byKey.set(key, group);
    }
    group.tests.push(test);
  }
  // Failures before flaky before blocked, then the biggest group first; stable otherwise.
  const rank = (g: FailureGroup) =>
    g.tests.some((t) => t.verdict === "failed")
      ? 0
      : g.tests.some((t) => t.verdict === "flaky")
        ? 1
        : 2;
  const groups = [...byKey.values()].sort(
    (a, b) => rank(a) - rank(b) || b.tests.length - a.tests.length,
  );

  const calls = [...run.modelCalls, ...tests.flatMap((t) => t.modelCalls)];
  return {
    run,
    tests,
    groups,
    heals: tests.flatMap((test) => test.heals.map((heal) => ({ test, heal }))),
    softWarnings: tests.flatMap((test) => test.softWarnings.map((warning) => ({ test, warning }))),
    subscriptionCalls: calls.filter((c) => c.billing === "subscription").length,
    tags: [...new Set(tests.flatMap((t) => t.tags))].sort(),
    diagnostics: (data.diagnostics ?? []).filter((d) => d.severity !== "info"),
  };
}

/** The run's overall word: the worst verdict present. */
export function runStatus(model: ReportModel): Verdict | "empty" {
  const { run } = model;
  if (run.blocked) return "blocked";
  for (const verdict of ["failed", "flaky", "blocked", "healed", "passed"] as const)
    if (run.totals[verdict] > 0) return verdict;
  return "empty";
}

/** "$0.0184", "$0.00 · 3 calls via your subscription", "$1.25 (+2 unpriced)". */
export function costText(
  usd: number,
  unpricedCalls: number,
  subscriptionCalls: number,
  format: (usd: number) => string,
): string {
  let text = format(usd);
  if (subscriptionCalls > 0)
    text += ` · ${subscriptionCalls} call${subscriptionCalls === 1 ? "" : "s"} via your subscription`;
  if (unpricedCalls > 0) text += ` (+${unpricedCalls} unpriced)`;
  return text;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
