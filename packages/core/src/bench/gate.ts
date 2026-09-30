import { type BenchReport, compareToBaseline, type DecisionEvalSummary } from "./report.js";

// The eval gate (LRN-10, guarantee 2): a candidate model, prompt or decision
// backend is only adopted when Bench shows no rise in false passes and the
// decision evals no rise in false labels, against the committed baseline.
// No baseline is no evidence: the gate fails.

export interface GateInput {
  bench?: { now: BenchReport; baseline: BenchReport | null };
  decisions?: { now: DecisionEvalSummary; baseline: DecisionEvalSummary | null };
  /** Model evals: false passes per candidate against the reference (the baseline model). */
  models?: { now: { model: string; falsePasses: number }[]; baseline: number | null };
}

export interface GateResult {
  passed: boolean;
  /** One line per check, "ok" or why it fails. */
  lines: string[];
  exitCode: 0 | 1;
}

export function evalGate(input: GateInput): GateResult {
  const lines: string[] = [];
  let passed = true;
  const fail = (line: string) => {
    passed = false;
    lines.push(`FAIL  ${line}`);
  };
  const ok = (line: string) => lines.push(`ok    ${line}`);

  if (input.bench) {
    const { now, baseline } = input.bench;
    if (!baseline) fail("Bench: no committed baseline to compare with (bench/baseline.json).");
    else {
      const cmp = compareToBaseline(now, baseline);
      const fp = now.total.falsePass;
      const before = baseline.total.falsePass;
      if (cmp.falsePassRose)
        fail(
          `Bench false passes rose: ${before.count} → ${fp.count}${cmp.newFalsePasses.length ? ` (new: ${cmp.newFalsePasses.join(", ")})` : ""}.`,
        );
      else ok(`Bench false passes: ${fp.count} of ${fp.of} (baseline ${before.count}).`);
    }
  }
  if (input.decisions) {
    const { now, baseline } = input.decisions;
    if (!baseline) fail("Decision evals: no committed baseline to compare with.");
    else
      for (const task of now.tasks) {
        const was = baseline.tasks.find((t) => t.task === task.task)?.falseLabels ?? 0;
        if (task.falseLabels > was)
          fail(
            `Decision eval ${task.task} (${now.backend}): false labels rose ${was} → ${task.falseLabels}.`,
          );
        else
          ok(
            `Decision eval ${task.task} (${now.backend}): ${task.falseLabels} false labels (baseline ${was}).`,
          );
      }
  }
  if (input.models) {
    const { now, baseline } = input.models;
    if (baseline === null)
      fail("Model evals: no reference result to compare with (bench/results).");
    else
      for (const model of now) {
        if (model.falsePasses > baseline)
          fail(`Model ${model.model}: ${model.falsePasses} false passes (reference ${baseline}).`);
        else ok(`Model ${model.model}: ${model.falsePasses} false passes (reference ${baseline}).`);
      }
  }
  if (lines.length === 0) fail("Nothing was evaluated.");
  return { passed, lines, exitCode: passed ? 0 : 1 };
}
