import { mkdirSync, writeFileSync } from "node:fs";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";
import { expectation, type Manifest, readManifest } from "./manifest.js";
import { type Attempt, mismatch, type Outcome, outcomeOf } from "./verdicts.js";

// Scores the reference run: every semantic result must match manifest.yaml
// (verdict, and the failing step), and the brittle suite must pass on correct
// and fail on cosmetic. The run passes only if all of that holds, even though
// the broken variants make individual tests fail.

interface Row {
  suite: string;
  variant: string;
  test: string;
  outcome: Outcome;
  problem: string | null;
}

function failedStep(steps: readonly TestStep[]): string | null {
  for (const step of steps) {
    if (step.category === "test.step") {
      if (step.error) return step.title;
      continue;
    }
    // The spec fixture's own steps (an auth: profile's "0. auth: ada" login) sit under the fixture.
    if (step.category === "fixture" || step.category === "hook") {
      const inner = failedStep(step.steps);
      if (inner) return inner;
    }
  }
  return null;
}

export default class VerdictReporter implements Reporter {
  private readonly manifest: Manifest = readManifest();
  private readonly attempts = new Map<TestCase, Attempt[]>();

  onTestEnd(test: TestCase, result: TestResult): void {
    const list = this.attempts.get(test) ?? [];
    list.push({ passed: result.status === "passed", failedStep: failedStep(result.steps) });
    this.attempts.set(test, list);
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult["status"] }> {
    const rows: Row[] = [];
    const seen = new Set<string>();
    for (const [test, attempts] of this.attempts) {
      const project = test.parent.project();
      const suite = String(project?.metadata.suite ?? "");
      const variant = String(project?.metadata.variant ?? "");
      const outcome = outcomeOf(attempts);
      let problem: string | null;
      if (suite === "semantic") {
        seen.add(`${test.title} × ${variant}`);
        problem = mismatch(expectation(this.manifest, test.title, variant), outcome);
      } else {
        const want = variant === "cosmetic" ? "failed" : "passed";
        const got = outcome.verdict === "passed" ? "passed" : "failed";
        problem = want === got ? null : `expected ${want} on ${variant}, got ${got}`;
      }
      rows.push({ suite, variant, test: test.title, outcome, problem });
    }
    const variantsRun = new Set(rows.filter((r) => r.suite === "semantic").map((r) => r.variant));
    for (const test of Object.keys(this.manifest.tests)) {
      for (const variant of variantsRun) {
        if (!seen.has(`${test} × ${variant}`)) {
          const outcome: Outcome = { verdict: "failed", step: null, failedStep: null };
          rows.push({ suite: "semantic", variant, test, outcome, problem: "not run" });
        }
      }
    }

    const problems = rows.filter((row) => row.problem);
    const lines = ["", "Reference results vs manifest.yaml"];
    for (const variant of [...new Set(rows.map((r) => r.variant))]) {
      const mine = rows.filter((r) => r.variant === variant);
      const summary = mine
        .filter((r) => r.suite === "semantic")
        .map((r) =>
          r.outcome.verdict === "passed"
            ? null
            : `${r.test}=${r.outcome.verdict}@${r.outcome.step}`,
        )
        .filter(Boolean);
      const bad = mine.filter((r) => r.problem).length;
      lines.push(
        `  ${bad ? "✗" : "✓"} ${variant.padEnd(22)} ${mine.length} checks${summary.length ? `  (${summary.join(", ")})` : ""}`,
      );
    }
    for (const row of problems) {
      lines.push(`  MISMATCH ${row.suite}:${row.variant} ${row.test}: ${row.problem}`);
    }
    lines.push(
      problems.length
        ? `${problems.length} result(s) differ from the manifest.`
        : `All ${rows.length} results match the manifest.`,
      "",
    );
    process.stdout.write(lines.join("\n"));

    mkdirSync("playwright-report", { recursive: true });
    writeFileSync("playwright-report/verdicts.json", `${JSON.stringify(rows, null, 2)}\n`);

    if (result.status === "interrupted" || result.status === "timedout") {
      return { status: result.status };
    }
    return { status: problems.length || rows.length === 0 ? "failed" : "passed" };
  }

  printsToStdio(): boolean {
    return false;
  }
}
