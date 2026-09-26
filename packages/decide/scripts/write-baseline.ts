// Writes evals/baseline.json: the rules-only eval results the README quotes and
// a test holds the rules to. Run after changing rules or eval sets:
//   pnpm --filter ./packages/decide build && node packages/decide/scripts/write-baseline.ts
import { writeFileSync } from "node:fs";
import { createDecisions } from "@testament/decide";
import { EVAL_TASKS, loadEvalSet, runEval } from "@testament/decide/node";

const decisions = createDecisions({ backend: null });
const baseline: Record<string, object> = {};
for (const task of EVAL_TASKS) {
  const r = await runEval(decisions, task, loadEvalSet(task), { backend: "rules" });
  baseline[task] = {
    cases: r.cases,
    decided: r.decided,
    escalated: r.escalated,
    falseLabels: r.falseLabels,
    decidedPct: r.decidedPct,
  };
}
writeFileSync(
  new URL("../evals/baseline.json", import.meta.url),
  `${JSON.stringify(baseline, null, 2)}\n`,
);
console.log(baseline);
