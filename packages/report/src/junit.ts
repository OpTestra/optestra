import { stepLabel } from "@optestra/contract";
import { escapeXml as x, escapeXmlAttr as xa } from "./escape.js";
import {
  buildModel,
  CAUSE_LABEL,
  checkLine,
  type RunData,
  type TestView,
  VERDICT_LABEL,
  words,
} from "./model.js";

// JUnit XML (EVD-4) in the common Jenkins / Surefire / GitLab shape:
// testsuites > testsuite > testcase, with failure / skipped / properties.
//   failed  → <failure> with the headline, expected / actual and the failing step
//   blocked → <skipped> with the reason
//   flaky   → passes, with a `flaky` property and the failed attempt's headline
//   healed  → passes, with a `healed` property and the fix count

const seconds = (ms: number) => (ms / 1000).toFixed(3);

function property(name: string, value: string | number | boolean): string {
  return `<property name="${xa(name)}" value="${xa(String(value))}"/>`;
}

function failureText(test: TestView): string {
  const lines: string[] = [];
  if (test.headline) lines.push(test.headline);
  if (test.cause) lines.push(`Cause: ${CAUSE_LABEL[test.cause]}`);
  const check = test.failingCheck?.check;
  if (check) {
    lines.push(`Check: ${check.generated.description}`);
    lines.push(`Written as: ${check.expectation}`);
    if (check.expected !== null) lines.push(`Expected: ${check.expected}`);
    if (check.actual !== null) lines.push(`Actual: ${check.actual}`);
  }
  const step = test.failingStep;
  if (step) {
    lines.push(`Step ${stepLabel(step.step)} (attempt ${step.attempt}): ${step.step.text}`);
    if (step.step.error && step.step.error !== test.headline)
      lines.push(`Error: ${step.step.error}`);
  }
  lines.push(`File: ${test.file}`);
  if (test.screenshot) lines.push(`Screenshot: ${test.screenshot}`);
  return lines.join("\n");
}

/** Testcase names, with the matrix entry added when a name would repeat. */
function caseNames(tests: readonly TestView[]): string[] {
  const counts = new Map<string, number>();
  for (const t of tests) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return tests.map((t) =>
    (counts.get(t.name) ?? 0) > 1 && t.matrix ? `${t.name} [${t.matrix}]` : t.name,
  );
}

function testcase(test: TestView, name: string): string {
  const props: string[] = [property("verdict", test.verdict), property("testId", test.ref.testId)];
  if (test.matrix) props.push(property("matrix", test.matrix));
  for (const tag of test.tags) props.push(property("tag", tag));
  if (test.ref.attempts > 1) props.push(property("attempts", test.ref.attempts));
  props.push(property("aiCalls", test.ref.aiCalls), property("costUsd", test.ref.costUsd));
  if (test.verdict === "flaky") {
    props.push(property("flaky", true));
    if (test.headline) props.push(property("flaky.headline", test.headline));
    if (test.cause) props.push(property("flaky.cause", test.cause));
  }
  if (test.verdict === "healed") {
    props.push(property("healed", true), property("healed.fixes", test.heals.length));
  }

  const mocked = test.mocks.reduce((n, m) => n + m.hits, 0);
  if (test.mocks.length > 0) props.push(property("mocked.responses", mocked));
  // EVD-6: warnings only, never a failure.
  if (test.accessibility) {
    props.push(property("accessibility.pages", test.accessibility.pages));
    props.push(property("accessibility.warnings", test.accessibility.violations.length));
    for (const v of test.accessibility.violations)
      props.push(property("accessibility.warning", `${v.page} ${v.rule}: ${v.help}`));
  }
  let outcome = "";
  if (test.muted) {
    props.push(property("muted", true));
    if (test.muted.until) props.push(property("muted.until", test.muted.until));
    props.push(property("muted.reason", test.muted.reason));
  }
  // DIA-5: a muted test that didn't pass is reported as skipped, never as a failure.
  if (test.muted && test.verdict !== "passed") {
    outcome = `<skipped message="${xa(`Muted${test.muted.until ? ` until ${test.muted.until}` : ""} (${test.verdict}): ${test.muted.reason}`)}"/>`;
  } else if (test.verdict === "failed") {
    outcome = `<failure message="${xa(test.headline ?? "Failed")}" type="${xa(test.cause ?? "failed")}">${x(failureText(test))}</failure>`;
  } else if (test.verdict === "blocked") {
    const reason = test.blocked
      ? `${words(test.blocked.reason)}: ${test.blocked.message}`
      : (test.headline ?? VERDICT_LABEL.blocked);
    outcome = `<skipped message="${xa(`Blocked (${reason})`)}"/>`;
  }
  let out = "";
  if (test.verdict === "flaky" && test.failingCheck)
    out = `<system-out>${x(`Failed attempt ${test.failingCheck.attempt}: ${checkLine(test.failingCheck.check)}`)}</system-out>`;

  return `    <testcase name="${xa(name)}" classname="${xa(test.file)}" file="${xa(test.file)}" time="${seconds(test.ref.durationMs)}">
      <properties>${props.join("")}</properties>${outcome ? `\n      ${outcome}` : ""}${out ? `\n      ${out}` : ""}
    </testcase>`;
}

/** One `<testsuite>` for the run, one `<testcase>` per test result (so per matrix entry). */
export function renderJunit(data: RunData): string {
  const model = buildModel(data);
  const { run } = model;
  const names = caseNames(model.tests);
  // Muted tests that didn't pass are skipped, not failures (DIA-5).
  const mutedNotPassed = model.tests.filter((t) => t.muted && t.verdict !== "passed");
  const failures = run.totals.failed - mutedNotPassed.filter((t) => t.verdict === "failed").length;
  const skipped =
    run.totals.blocked -
    mutedNotPassed.filter((t) => t.verdict === "blocked").length +
    mutedNotPassed.length;
  const suiteProps = [
    property("runId", run.runId),
    property("project", run.project),
    property("environment", run.environment ?? ""),
    property("target", run.target),
    property("trigger", run.trigger),
    property("mode", run.mode),
    property("engineVersion", run.engineVersion),
    property("contractVersion", run.contractVersion),
    property("aiCalls", run.cost.aiCalls),
    property("costUsd", run.cost.usd),
  ];
  if (run.git?.branch) suiteProps.push(property("git.branch", run.git.branch));
  if (run.git?.commit) suiteProps.push(property("git.commit", run.git.commit));
  if (run.git?.pr) suiteProps.push(property("git.pr", run.git.pr));
  for (const verdict of ["passed", "healed", "flaky"] as const)
    suiteProps.push(property(`totals.${verdict}`, run.totals[verdict]));
  if (run.totals.muted) suiteProps.push(property("totals.muted", run.totals.muted));
  if (run.blocked)
    suiteProps.push(property("blocked", `${run.blocked.reason}: ${run.blocked.message}`));

  const counts = `tests="${run.totals.tests}" failures="${failures}" errors="0" skipped="${skipped}" time="${seconds(run.durationMs)}"`;
  const suiteName = [run.project, run.environment].filter(Boolean).join(" · ");
  const err = run.blocked
    ? `\n    <system-err>${x(`Run blocked (${words(run.blocked.reason)}): ${run.blocked.message}`)}</system-err>`
    : "";
  const timestamp = run.startedAt.replace(/\.\d+Z$/, "").replace(/Z$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${xa(suiteName)}" ${counts}>
  <testsuite name="${xa(suiteName)}" ${counts} timestamp="${timestamp}" id="${xa(run.runId)}">
    <properties>${suiteProps.join("")}</properties>
${model.tests.map((t, i) => testcase(t, names[i] ?? t.name)).join("\n")}${err}
  </testsuite>
</testsuites>
`;
}
