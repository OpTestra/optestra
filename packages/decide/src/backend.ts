import type { Question, QuestionKind, Questions } from "./task.js";

/** What a backend is asked: the task's state text and the questions to answer. */
export interface BackendRequest {
  state: string;
  questions: Questions;
}

/** One answered question. For `noul`, `value` is true/false and `probabilities` may hold `{ true: p }`. */
export interface BackendAnswer {
  kind: QuestionKind;
  value: string | boolean;
  /** Calibrated confidence in `value`, 0–1. */
  confidence: number;
  /** Optional distribution over options/levels (or `true`) as the model reported it. */
  probabilities?: Record<string, number>;
}

export interface BackendFailure {
  /** snake_case, e.g. timeout, unavailable, invalid_response, rate_limited. */
  reason: string;
  message?: string;
}

export type BackendResponse =
  | { ok: true; answers: Record<string, BackendAnswer> }
  | { ok: false; failure: BackendFailure };

export interface BackendCallOptions {
  /** Aborted when the time limit passes or the decision loses a race. */
  signal: AbortSignal;
  /** Time left for this call. */
  timeoutMs: number;
}

/**
 * A decision model (DEC-1: Jev, Kev, Laya via the System One API). A backend
 * may take many questions in one call (batching). It should resolve with
 * `{ ok: false }` rather than throw; the pipeline treats a throw the same way.
 */
export interface DecisionBackend {
  /** Recorded as the decision's `source` and part of the cache key. */
  readonly id: string;
  answer(request: BackendRequest, options: BackendCallOptions): Promise<BackendResponse>;
}

/** Checks one answer against its question: right kind, a known option/level, confidence in 0–1. */
export function validAnswer(question: Question, answer: BackendAnswer | undefined): boolean {
  if (!answer || answer.kind !== question.kind) return false;
  if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)
    return false;
  switch (question.kind) {
    case "choice":
      return typeof answer.value === "string" && question.options.includes(answer.value);
    case "score":
      return typeof answer.value === "string" && question.levels.includes(answer.value);
    case "noul":
      return typeof answer.value === "boolean";
  }
}

export interface MockBackendOptions {
  id?: string;
  /** Answers each request. Defaults to answering every question with its first option/level or true at 0.9. */
  respond?: (request: BackendRequest) => BackendResponse | Promise<BackendResponse>;
  /** Waits this long (respecting the abort signal) before responding. */
  delayMs?: number;
}

export interface MockBackend extends DecisionBackend {
  /** Every request received, in order. */
  readonly calls: BackendRequest[];
  /** Calls whose signal was aborted before they responded. */
  readonly aborted: number;
}

/** Scripted backend for tests. Makes no network calls. */
export function mockBackend(options: MockBackendOptions = {}): MockBackend {
  const calls: BackendRequest[] = [];
  let aborted = 0;
  const respond =
    options.respond ??
    ((request: BackendRequest): BackendResponse => ({
      ok: true,
      answers: Object.fromEntries(
        Object.entries(request.questions).map(([id, q]) => [
          id,
          {
            kind: q.kind,
            value: q.kind === "choice" ? q.options[0] : q.kind === "score" ? q.levels[0] : true,
            confidence: 0.9,
          } as BackendAnswer,
        ]),
      ),
    }));
  return {
    id: options.id ?? "mock",
    calls,
    get aborted() {
      return aborted;
    },
    async answer(request, { signal }) {
      calls.push(request);
      if (options.delayMs) {
        const finished = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(true), options.delayMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve(false);
          });
        });
        if (!finished) {
          aborted++;
          return { ok: false, failure: { reason: "aborted" } };
        }
      }
      return respond(request);
    },
  };
}
