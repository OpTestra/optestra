import { existsSync, readFileSync } from "node:fs";
import type { Decisions } from "../decide.js";

/**
 * Eval sets (LRN-10 foundation): labelled inputs per after-run task in
 * `packages/decide/evals/<task>.jsonl`, and the runner behind
 * `decisions --eval`. A false label (a decided answer that is wrong) is the
 * number that matters: escalating is always allowed, guessing wrong is not.
 */

export const EVAL_TASKS = [
  "failure_cause",
  "flaky_or_real",
  "duplicate_or_new",
  "heal_class",
] as const;
export type EvalTask = (typeof EVAL_TASKS)[number];

export interface EvalCase {
  id: string;
  source: string;
  note: string;
  input: unknown;
  /** The correct answer to the task's one question. */
  expected: string | boolean;
}

export interface EvalMistake {
  id: string;
  note: string;
  expected: string | boolean;
  got: string | boolean;
  source: string;
  confidence: number;
}

export interface EvalReport {
  task: string;
  backend: string;
  cases: number;
  decided: number;
  escalated: number;
  correct: number;
  /** Decided but wrong. */
  falseLabels: number;
  /** Correct / decided (1 when nothing was decided). */
  accuracy: number;
  decidedPct: number;
  escalatedPct: number;
  p50Ms: number;
  /** p50 over the cases where the backend was actually asked; null when it never was. */
  modelP50Ms: number | null;
  /** Cases where the backend was asked. */
  modelCalls: number;
  /** Decided by the rules vs the backend. */
  byRules: number;
  byModel: number;
  mistakes: EvalMistake[];
  /** Escalations by reason (below_threshold, undecided, timeout, backend_error, …). */
  escalations: Record<string, number>;
}

/**
 * Answers that mean "I can't tell" rather than a label: counted as escalations
 * (reason `abstained`), never as right or wrong.
 */
export const ABSTAIN: Partial<Record<string, string>> = { heal_class: "unknown" };

/** The committed eval sets' folder. */
export const evalsDir = new URL("../../evals/", import.meta.url);

export function loadEvalSet(task: string, dir: URL = evalsDir): EvalCase[] {
  const file = new URL(`${task}.jsonl`, dir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as EvalCase);
}

const pct = (part: number, total: number) =>
  total === 0 ? 0 : Math.round((part / total) * 1000) / 10;

/** Runs every case through `decisions` (cache bypassed) and scores it. */
export async function runEval(
  decisions: Decisions,
  task: string,
  cases: readonly EvalCase[],
  options: { backend?: string } = {},
): Promise<EvalReport> {
  const latencies: number[] = [];
  const modelLatencies: number[] = [];
  const mistakes: EvalMistake[] = [];
  const escalations: Record<string, number> = {};
  let decided = 0;
  let correct = 0;
  let byRules = 0;
  for (const c of cases) {
    const result = await decisions.decide(task, c.input as never, { bypassCache: true });
    latencies.push(result.latencyMs);
    if (result.backend && !result.backend.skipped) modelLatencies.push(result.latencyMs);
    if (result.status !== "decided") {
      escalations[result.reason] = (escalations[result.reason] ?? 0) + 1;
      continue;
    }
    const got = Object.values(result.answers as Record<string, string | boolean>)[0] as
      | string
      | boolean;
    if (ABSTAIN[task] !== undefined && got === ABSTAIN[task]) {
      escalations.abstained = (escalations.abstained ?? 0) + 1;
      continue;
    }
    decided++;
    if (result.source === "rules") byRules++;
    if (got === c.expected) correct++;
    else
      mistakes.push({
        id: c.id,
        note: c.note,
        expected: c.expected,
        got,
        source: result.source,
        confidence: result.confidence,
      });
  }
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return Math.round((sorted[Math.floor((sorted.length - 1) / 2)] ?? 0) * 10) / 10;
  };
  return {
    task,
    backend: options.backend ?? decisions.backends.after?.id ?? "rules",
    cases: cases.length,
    decided,
    escalated: cases.length - decided,
    correct,
    falseLabels: decided - correct,
    accuracy: decided === 0 ? 1 : Math.round((correct / decided) * 1000) / 1000,
    decidedPct: pct(decided, cases.length),
    escalatedPct: pct(cases.length - decided, cases.length),
    p50Ms: median(latencies),
    modelP50Ms: modelLatencies.length ? median(modelLatencies) : null,
    modelCalls: modelLatencies.length,
    byRules,
    byModel: decided - byRules,
    mistakes,
    escalations,
  };
}
