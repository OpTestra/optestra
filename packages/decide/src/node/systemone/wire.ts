import type { BackendAnswer, BackendFailure, BackendResponse } from "../../backend.js";
import type { Question, Questions } from "../../task.js";

/**
 * The ONE place our questions and answers meet the System One wire format
 * (TypeSafe's `/v1/systemone`, also served by Kev and by Ollaya, whose native
 * `/api/decide` adds `keep_alive` and `state_truncated`). Tested against
 * recorded examples in `fixtures/systemone/`.
 */

export type Flavor = "systemone" | "ollaya";

export interface WireQuestion {
  type: "choice" | "score" | "noul";
  instructions: string;
  /** choice: option → description (null); score: ordered level descriptions; noul: omitted. */
  criteria?: Record<string, null> | string[];
}

export interface WireRequest {
  model: string;
  state: string;
  questions: Record<string, WireQuestion>;
  /** Ollaya only: how long the model stays loaded afterwards. */
  keep_alive?: string;
}

export function toWireQuestion(question: Question, scrub: (text: string) => string): WireQuestion {
  const instructions = scrub(question.instructions);
  switch (question.kind) {
    case "choice":
      return {
        type: "choice",
        instructions,
        criteria: Object.fromEntries(question.options.map((option) => [option, null])),
      };
    case "score":
      return { type: "score", instructions, criteria: [...question.levels] };
    case "noul":
      // criteria is optional for a noul and, when sent, must be an object; we send none.
      return { type: "noul", instructions };
  }
}

export function toWireRequest(options: {
  model: string;
  state: string;
  questions: Questions;
  flavor: Flavor;
  keepAlive?: string;
  scrub: (text: string) => string;
}): WireRequest {
  const request: WireRequest = {
    model: options.model,
    state: options.scrub(options.state),
    questions: Object.fromEntries(
      Object.entries(options.questions).map(([id, q]) => [id, toWireQuestion(q, options.scrub)]),
    ),
  };
  if (options.flavor === "ollaya" && options.keepAlive) request.keep_alive = options.keepAlive;
  return request;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const invalid = (message: string): BackendResponse => ({
  ok: false,
  failure: { reason: "invalid_response", message },
});

/** One wire answer → our answer, or a reason it can't be used. */
function toAnswer(question: Question, wire: unknown): BackendAnswer | string {
  if (!isObject(wire)) return "missing";
  if (wire.type !== question.kind) return `type ${String(wire.type)}, expected ${question.kind}`;
  switch (question.kind) {
    case "noul": {
      const p = wire.noul;
      if (!isProbability(p)) return "noul is not a probability";
      // No confidence on the wire for a noul: confidence is how far p is from a coin flip.
      const confidence = Math.round(Math.max(p, 1 - p) * 10_000) / 10_000;
      return { kind: "noul", value: p >= 0.5, confidence, probabilities: { true: p } };
    }
    case "choice": {
      if (typeof wire.choice !== "string" || !question.options.includes(wire.choice))
        return `unknown option ${JSON.stringify(wire.choice)}`;
      if (!isProbability(wire.confidence)) return "confidence out of range";
      const probabilities: Record<string, number> = {};
      if (isObject(wire.probabilities)) {
        for (const option of question.options) {
          const p = wire.probabilities[option];
          if (isProbability(p)) probabilities[option] = p;
        }
      }
      return { kind: "choice", value: wire.choice, confidence: wire.confidence, probabilities };
    }
    case "score": {
      if (!isProbability(wire.confidence)) return "confidence out of range";
      const levels = question.levels;
      const probabilities: Record<string, number> = {};
      let mode = -1;
      let best = -1;
      if (isObject(wire.probabilities)) {
        levels.forEach((level, i) => {
          const p = (wire.probabilities as Record<string, unknown>)[String(i)];
          if (!isProbability(p)) return;
          probabilities[level] = p;
          if (p > best) {
            best = p;
            mode = i;
          }
        });
      }
      // The wire `score` is the expected level (Σ i·pᵢ); our answer is the most likely level.
      if (mode < 0 && typeof wire.score === "number" && Number.isFinite(wire.score))
        mode = Math.min(levels.length - 1, Math.max(0, Math.round(wire.score)));
      const value = levels[mode];
      if (value === undefined) return "no level";
      return { kind: "score", value, confidence: wire.confidence, probabilities };
    }
  }
}

/**
 * A 2xx response body → answers for every question we asked. Any missing or
 * malformed answer makes the whole response invalid: a backend that answers
 * something we didn't ask for never becomes a decision.
 */
export function fromWireResponse(questions: Questions, body: unknown): BackendResponse {
  if (!isObject(body) || !isObject(body.answers)) return invalid("no answers in the response");
  const answers: Record<string, BackendAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = toAnswer(question, body.answers[id]);
    if (typeof answer === "string") return invalid(`answer "${id}": ${answer}`);
    answers[id] = answer;
  }
  const response: BackendResponse = { ok: true, answers };
  if (isObject(body.usage)) {
    const input = body.usage.input_tokens;
    const output = body.usage.output_tokens;
    response.usage = {
      inputTokens: typeof input === "number" && input >= 0 ? input : 0,
      outputTokens: typeof output === "number" && output >= 0 ? output : 0,
    };
  }
  if (typeof body.model === "string") response.model = body.model;
  if (body.state_truncated === true) response.stateTruncated = true;
  return response;
}

/**
 * Error body → a short message. Handles Ollaya (`{ error, code, detail }`) and
 * TypeSafe (`{ detail: { error_type, message } }` or FastAPI's `{ detail: [...] }`).
 * Never includes `detail[].input`: TypeSafe echoes the request (and its state) there.
 */
export function errorMessage(body: unknown): string | undefined {
  if (!isObject(body)) return undefined;
  const issues = (list: unknown[]) =>
    list
      .filter(isObject)
      .map((d) => {
        const loc = Array.isArray(d.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
        return `${loc}${loc ? ": " : ""}${String(d.msg ?? "invalid")}`;
      })
      .join("; ");
  let message: string | undefined;
  if (typeof body.code === "string") message = `${body.code}: ${String(body.error ?? "")}`;
  else if (isObject(body.detail))
    message = `${String(body.detail.error_type ?? "error")}: ${String(body.detail.message ?? "")}`;
  else if (Array.isArray(body.detail)) message = issues(body.detail);
  else if (typeof body.error === "string") message = body.error;
  return message?.slice(0, 300);
}

/** A non-2xx response → a snake_case failure reason the pipeline and `--check` understand. */
export function failureFromHttp(status: number, body: unknown): BackendFailure {
  const message = errorMessage(body) ?? `HTTP ${status}`;
  const code = isObject(body) && typeof body.code === "string" ? body.code : undefined;
  const reason =
    status === 401 || status === 403
      ? "unauthorized"
      : code === "MODEL_NOT_FOUND" || /unknown model/i.test(message)
        ? "model_not_found"
        : status === 404
          ? "not_found"
          : status === 400 || status === 413 || status === 422
            ? "invalid_request"
            : status === 429
              ? "rate_limited"
              : status === 503 || status === 529
                ? "overloaded"
                : status >= 500
                  ? "server_error"
                  : `http_${status}`;
  return { reason, message };
}
