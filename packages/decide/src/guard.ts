import { VERDICTS } from "@testament/contract";
import { type AnyTask, QUESTION_KINDS, type Questions } from "./task.js";

/**
 * Words a decision may never output (LRN-8): verdicts stay with the
 * deterministic checks. Covers the contract's verdicts plus pass/fail/verdict.
 */
export const VERDICT_WORDS: ReadonlySet<string> = new Set([...VERDICTS, "pass", "fail", "verdict"]);

const VERDICT_STATEMENT =
  /\b(test|step|check|run)s?\s+(has\s+|have\s+)?(pass|passed|fail|failed)\b/i;
const NAME = /^[a-z][a-z0-9_]*$/;

/**
 * The no-verdict rules alone, for questions built from an input
 * (`questionsFor`): no verdict words in ids, options, levels or instructions.
 */
export function verdictProblems(questions: Questions): string[] {
  const problems: string[] = [];
  for (const [id, question] of Object.entries(questions)) {
    if (id.split("_").some((part) => VERDICT_WORDS.has(part)))
      problems.push(`question "${id}": a decision may not output a verdict (id)`);
    const values =
      question.kind === "choice"
        ? question.options
        : question.kind === "score"
          ? question.levels
          : [];
    for (const value of values)
      if (
        value
          .toLowerCase()
          .split(/[^a-z]+/)
          .some((part) => VERDICT_WORDS.has(part))
      )
        problems.push(`question "${id}": a decision may not output a verdict ("${value}")`);
    if (VERDICT_STATEMENT.test(question.instructions))
      problems.push(`question "${id}": a decision may not judge whether a test passed or failed`);
  }
  return problems;
}

/** Everything wrong with a task spec; empty when it may be registered. */
export function taskProblems(task: AnyTask): string[] {
  const problems: string[] = [];
  if (!NAME.test(task.name)) problems.push(`name "${task.name}" must be snake_case`);
  if (!Number.isInteger(task.version) || task.version < 1)
    problems.push("version must be a positive integer");
  if (task.threshold !== undefined && !(task.threshold >= 0 && task.threshold <= 1))
    problems.push("threshold must be between 0 and 1");
  if (task.timeLimitMs !== undefined && !(task.timeLimitMs > 0))
    problems.push("timeLimitMs must be positive");
  const entries = Object.entries(task.questions);
  if (entries.length === 0) problems.push("needs at least one question");
  for (const [id, question] of entries) {
    const where = `question "${id}"`;
    if (!NAME.test(id)) problems.push(`${where}: id must be snake_case`);
    if (!QUESTION_KINDS.includes(question.kind)) problems.push(`${where}: unknown kind`);
    if (id.split("_").some((part) => VERDICT_WORDS.has(part)))
      problems.push(`${where}: a decision may not output a verdict (id)`);
    const values =
      question.kind === "choice"
        ? question.options
        : question.kind === "score"
          ? question.levels
          : [];
    if ((question.kind === "choice" || question.kind === "score") && values.length < 2)
      problems.push(
        `${where}: needs at least two ${question.kind === "choice" ? "options" : "levels"}`,
      );
    if (new Set(values).size !== values.length) problems.push(`${where}: duplicate values`);
    for (const value of values) {
      if (
        value
          .toLowerCase()
          .split(/[^a-z]+/)
          .some((part) => VERDICT_WORDS.has(part))
      )
        problems.push(`${where}: a decision may not output a verdict ("${value}")`);
    }
    if (VERDICT_STATEMENT.test(question.instructions))
      problems.push(`${where}: a decision may not judge whether a test passed or failed`);
  }
  return problems;
}
