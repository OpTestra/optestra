import type { EvidenceRef } from "@testament/contract";
import type { z } from "zod";

/**
 * The three kinds of typed question a decision model ("System One": Jev, Kev,
 * Laya) answers, and the only kinds a task may ask. Rules answer the same shapes.
 */
export const QUESTION_KINDS = ["choice", "score", "noul"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** Pick exactly one of `options`. */
export interface ChoiceQuestion<O extends readonly string[] = readonly string[]> {
  kind: "choice";
  instructions: string;
  options: O;
}

/** An ordinal level: `levels` are ordered lowest to highest. */
export interface ScoreQuestion<L extends readonly string[] = readonly string[]> {
  kind: "score";
  instructions: string;
  levels: L;
}

/** Is the statement in `instructions` true? Answered with a boolean. */
export interface NoulQuestion {
  kind: "noul";
  instructions: string;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type Questions = Record<string, Question>;

/** The value one question takes: an option, a level, or true/false. */
export type AnswerValue<Q extends Question> =
  Q extends ChoiceQuestion<infer O>
    ? O[number]
    : Q extends ScoreQuestion<infer L>
      ? L[number]
      : Q extends NoulQuestion
        ? boolean
        : never;

/** One value per question id. A task's answer shape is derived from its questions. */
export type Answers<Q extends Questions> = { [K in keyof Q]: AnswerValue<Q[K]> };

export type DecisionPhase = "during" | "after";

/** What the caller should do with an escalation. */
export type EscalateTo = "fixer" | "human" | "block";

/**
 * Why an answer was given (DIA-1, HEAL-6): a named signal, with a contract
 * EvidenceRef when it points at a step, check, decision or artifact.
 */
export interface Evidence {
  /** snake_case signal name, e.g. http_5xx, element_not_found, same_headline. */
  signal: string;
  /** Short plain detail for the report ("POST /api/signup → 500"). */
  detail?: string | undefined;
  /** For scored signals (same_element): how strongly it says "same", from -1 (no) to 1 (yes). */
  score?: number | undefined;
  /** The signal's weight in the combined score. */
  weight?: number | undefined;
  ref?: EvidenceRef | undefined;
}

/** A rules answer: every question answered, with one confidence for the whole answer. */
export interface RulesAnswer<Q extends Questions> {
  answers: Answers<Q>;
  confidence: number;
  /** The signals the rule used. Every decided answer should carry some. */
  evidence?: Evidence[];
}

/**
 * One kind of small typed decision (LRN-6). Adding a decision means writing one
 * of these and listing it in `tasks/index.ts`; the pipeline needs no change.
 */
export interface DecisionTask<I = unknown, Q extends Questions = Questions> {
  /** Stable snake_case id, used in config, records, cache keys and labels. */
  name: string;
  /** Bump when rules, questions or state change meaning: old cache entries stop matching. */
  version: number;
  /** One line for `decisions` listings. */
  description: string;
  /** During the run (fast, raced) or after it (batched). */
  phase: DecisionPhase;
  input: z.ZodType<I>;
  questions: Q;
  /**
   * Pure and fast (well under 1 ms). Return `null` when the rules can't tell.
   * A below-threshold answer is allowed: it goes to the backend, and is offered
   * as `best` if the decision escalates.
   */
  rules(input: I): RulesAnswer<Q> | null;
  /**
   * What a decision model sees. Wrap anything that came from the page or app in
   * `untrusted()` so a model never mistakes it for instructions.
   */
  state(input: I): string;
  /**
   * The input's signals a model had to go on, attached as evidence when a backend
   * (not the rules) decides. Optional; defaults to none.
   */
  evidence?(input: I): Evidence[];
  /**
   * Questions that depend on the input (e.g. duplicate_or_new's options are the
   * run's failure groups). Must have the same ids and kinds as `questions`; the
   * no-verdict guard runs on them too.
   */
  questionsFor?(input: I): Q;
  /** Minimum confidence to act on. Leave unset to use the project's `decisions.threshold`. */
  threshold?: number;
  /** Hard time limit for the whole decision. Defaults: 100 ms during, 2000 ms after. */
  timeLimitMs?: number;
  /** What the caller should do when this task escalates. */
  onEscalate: EscalateTo;
}

// biome-ignore lint/suspicious/noExplicitAny: any task, whatever its input and questions
export type AnyTask = DecisionTask<any, Questions>;
export type InputOf<T> = T extends DecisionTask<infer I, Questions> ? I : never;
export type QuestionsOf<T> = T extends DecisionTask<unknown, infer Q> ? Q : Questions;

/** The questions asked for this input: `questionsFor(input)` when the task has it. */
export function questionsOf(task: AnyTask, input: unknown): Questions {
  return task.questionsFor ? task.questionsFor(input) : task.questions;
}

/** Identity helper that keeps a task's input and question types for inference. */
export function defineTask<I, const Q extends Questions>(
  task: DecisionTask<I, Q>,
): DecisionTask<I, Q> {
  return task;
}

export const DEFAULT_TIME_LIMIT_MS: Record<DecisionPhase, number> = { during: 100, after: 2000 };

/**
 * Marks page- or app-derived text for a model. The closing marker is escaped
 * inside the text so page content can't end the block early.
 */
export function untrusted(label: string, text: string): string {
  const safe = text.replaceAll("</untrusted>", "<\\/untrusted>");
  return `<untrusted source="${label}">\n${safe}\n</untrusted>`;
}
