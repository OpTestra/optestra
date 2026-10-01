import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brand } from "@optestra/brand";
import { defaultRedactor } from "@optestra/config/node";
import { validAnswer } from "../backend.js";
import type { AnyTask, Answers, InputOf, QuestionsOf } from "../task.js";

/** Where a label came from (LRN-9). */
export type LabelSource = "approved" | "rejected" | "confirmed";

/** One labelled example: the task input and the correct answers. */
export interface Label {
  task: string;
  version: number;
  source: LabelSource;
  /** ISO time it was recorded. */
  at: string;
  input: unknown;
  answers: Record<string, unknown>;
}

export interface LabelStoreOptions {
  /** Every line passes through this before it is written. Default: the process-wide redactor. */
  scrub?: (text: string) => string;
  now?: () => Date;
}

export interface LabelStore {
  readonly dir: string;
  /** Appends one example to `<task>.jsonl`. Throws on answers that don't fit the task's questions. */
  recordLabel<T extends AnyTask>(
    task: T,
    input: InputOf<T>,
    correctAnswers: Answers<QuestionsOf<T>>,
    options: { source: LabelSource },
  ): Label;
  /** Every example recorded for a task, oldest first. Malformed lines are skipped. */
  readLabels(task: string): Label[];
}

const TASK_NAME = /^[a-z][a-z0-9_]*$/;

/** `<project>/<dataDir>/labels/`. */
export function labelsDir(projectDir: string): string {
  return join(projectDir, brand.dataDirName, "labels");
}

/**
 * The labelled-examples store: `.<name>/labels/<task>.jsonl`, one example per
 * line, scrubbed by the redactor. Training and evals (later) read it.
 */
export function createLabelStore(projectDir: string, options: LabelStoreOptions = {}): LabelStore {
  const dir = labelsDir(projectDir);
  const scrub = options.scrub ?? ((text: string) => defaultRedactor.redact(text));
  const now = options.now ?? (() => new Date());
  return {
    dir,
    recordLabel(task, input, correctAnswers, { source }) {
      if (!TASK_NAME.test(task.name)) throw new TypeError(`Invalid task name "${task.name}"`);
      const parsed = task.input.safeParse(input);
      if (!parsed.success) throw new TypeError(`Label input does not fit task "${task.name}"`);
      const answers = correctAnswers as Record<string, unknown>;
      for (const [id, question] of Object.entries(task.questions)) {
        const value = answers[id] as string | boolean;
        if (!validAnswer(question, { kind: question.kind, value, confidence: 1 }))
          throw new TypeError(`Label answer "${id}" does not fit task "${task.name}"`);
      }
      const label: Label = {
        task: task.name,
        version: task.version,
        source,
        at: now().toISOString(),
        input: parsed.data,
        answers,
      };
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${task.name}.jsonl`), `${scrub(JSON.stringify(label))}\n`);
      return label;
    },
    readLabels(task) {
      if (!TASK_NAME.test(task)) return [];
      const file = join(dir, `${task}.jsonl`);
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line) => {
          if (line.trim() === "") return [];
          try {
            return [JSON.parse(line) as Label];
          } catch {
            return [];
          }
        });
    },
  };
}
