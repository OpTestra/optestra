import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDecisions } from "../decide.js";
import { EVAL_TASKS, loadEvalSet, runEval } from "./evals.js";

const baseline = JSON.parse(
  readFileSync(new URL("../../evals/baseline.json", import.meta.url), "utf8"),
) as Record<
  string,
  { cases: number; decided: number; escalated: number; falseLabels: number; decidedPct: number }
>;

describe("eval sets", () => {
  it("have at least 40 labelled cases per task, with unique ids and every source", () => {
    for (const task of EVAL_TASKS) {
      const cases = loadEvalSet(task);
      expect(cases.length, task).toBeGreaterThanOrEqual(40);
      expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
      expect(new Set(cases.map((c) => c.source))).toEqual(
        new Set(["contract-fixture", "shop-manifest", "hand-written"]),
      );
    }
  });

  it("rules only: zero false labels, matching the committed baseline", async () => {
    const decisions = createDecisions({ backend: null });
    for (const task of EVAL_TASKS) {
      const report = await runEval(decisions, task, loadEvalSet(task), { backend: "rules" });
      expect(report.mistakes, task).toEqual([]);
      expect({
        cases: report.cases,
        decided: report.decided,
        escalated: report.escalated,
        falseLabels: report.falseLabels,
        decidedPct: report.decidedPct,
      }).toEqual(baseline[task]);
      expect(report.byModel).toBe(0);
      expect(report.modelP50Ms).toBeNull();
    }
  });
});
