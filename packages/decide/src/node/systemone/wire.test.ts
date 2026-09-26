import { describe, expect, it } from "vitest";
import type { Questions } from "../../task.js";
import { fixture } from "./fake-server.test.helpers.js";
import { errorMessage, failureFromHttp, fromWireResponse, toWireRequest } from "./wire.js";

/** The questions behind `request-three-questions.json` (the recorded Jev and Ollaya answers). */
const THREE: Questions = {
  is_error: {
    kind: "noul",
    instructions:
      "This page is an error page (a server error, not-found or crash page) rather than the page the user meant to reach.",
  },
  kind: {
    kind: "choice",
    instructions: "What kind of page is this?",
    options: ["login", "error", "content"],
  },
  severity: {
    kind: "score",
    instructions: "How broken does this page look?",
    levels: ["Fine", "Degraded", "Broken"],
  },
};
const same = (text: string) => text;

describe("request mapping", () => {
  it("builds exactly the recorded request: choice criteria as an object, score as a list, noul without criteria", () => {
    const recorded = fixture("request-three-questions.json") as {
      state: string;
      questions: unknown;
    };
    const request = toWireRequest({
      model: "jev-latest",
      state: recorded.state,
      questions: THREE,
      flavor: "systemone",
      scrub: same,
    });
    expect(request).toEqual({ model: "jev-latest", ...recorded });
    expect(request).not.toHaveProperty("keep_alive");
  });

  it("adds keep_alive only for Ollaya", () => {
    const request = toWireRequest({
      model: "laya:typed-decisions",
      state: "s",
      questions: THREE,
      flavor: "ollaya",
      keepAlive: "30m",
      scrub: same,
    });
    expect(request.keep_alive).toBe("30m");
  });

  it("scrubs the state and the instructions", () => {
    const request = toWireRequest({
      model: "m",
      state: "token=sk-live-1234",
      questions: { q: { kind: "noul", instructions: "Is sk-live-1234 shown?" } },
      flavor: "systemone",
      scrub: (text) => text.replaceAll("sk-live-1234", "[secret:TOKEN]"),
    });
    expect(JSON.stringify(request)).not.toContain("sk-live-1234");
  });
});

describe("answer mapping (recorded examples)", () => {
  it("Jev (recorded): noul p → value p ≥ 0.5, confidence max(p, 1 − p); choice and score keep confidence", () => {
    const response = fromWireResponse(THREE, fixture("jev-response.json"));
    expect(response).toEqual({
      ok: true,
      answers: {
        is_error: { kind: "noul", value: false, confidence: 0.63, probabilities: { true: 0.37 } },
        kind: {
          kind: "choice",
          value: "login",
          confidence: 0.89,
          probabilities: { login: 0.92, error: 0.08, content: 0 },
        },
        // The wire score is the expected level (0.85); the answer is the most likely level.
        severity: {
          kind: "score",
          value: "Degraded",
          confidence: 0.23,
          probabilities: { Fine: 0.33, Degraded: 0.49, Broken: 0.18 },
        },
      },
      usage: { inputTokens: 428, outputTokens: 69 },
      model: "jev-1.13.0",
    });
  });

  it("Ollaya /api/decide (recorded): same shapes, plus the native fields", () => {
    const response = fromWireResponse(THREE, fixture("ollaya-decide.json"));
    expect(response.ok && response.answers.is_error).toEqual({
      kind: "noul",
      value: false,
      confidence: 0.7305,
      probabilities: { true: 0.2695 },
    });
    expect(response.ok && response.answers.severity?.value).toBe("Fine");
    expect(response).toMatchObject({ model: "laya:typed-decisions", usage: { inputTokens: 303 } });
    expect(response).not.toHaveProperty("stateTruncated");
    const truncated = fromWireResponse(THREE, {
      ...(fixture("ollaya-decide.json") as object),
      state_truncated: true,
    });
    expect(truncated).toMatchObject({ stateTruncated: true });
  });

  it("Ollaya /v1/systemone (recorded) maps like Jev", () => {
    expect(fromWireResponse(THREE, fixture("ollaya-v1.json"))).toMatchObject({
      ok: true,
      answers: { kind: { value: "login", confidence: 0.5426 } },
    });
  });

  it("Kev (doc-derived) maps like Jev", () => {
    const questions: Questions = {
      department: {
        kind: "choice",
        instructions: "x",
        options: ["returns", "shipping", "billing"],
      },
      escalate: { kind: "noul", instructions: "x" },
      frustration: {
        kind: "score",
        instructions: "x",
        levels: ["Calm", "Frustrated", "Very angry"],
      },
    };
    expect(fromWireResponse(questions, fixture("kev-response.json"))).toMatchObject({
      ok: true,
      answers: {
        department: { value: "returns", confidence: 0.21 },
        escalate: { value: true, confidence: 0.93 },
        frustration: { value: "Frustrated", confidence: 0.34 },
      },
      model: "kev-latest",
    });
  });

  it("rejects a response with an unknown option, a confidence out of range or a missing answer", () => {
    const jev = fixture("jev-response.json") as {
      answers: Record<string, Record<string, unknown>>;
    };
    const withAnswer = (id: string, patch: Record<string, unknown>) => ({
      ...jev,
      answers: { ...jev.answers, [id]: { ...jev.answers[id], ...patch } },
    });
    expect(fromWireResponse(THREE, withAnswer("kind", { choice: "banana" }))).toMatchObject({
      ok: false,
      failure: { reason: "invalid_response", message: 'answer "kind": unknown option "banana"' },
    });
    expect(fromWireResponse(THREE, withAnswer("severity", { confidence: 1.4 }))).toMatchObject({
      ok: false,
      failure: { reason: "invalid_response" },
    });
    expect(fromWireResponse(THREE, withAnswer("is_error", { noul: -0.1 }))).toMatchObject({
      ok: false,
    });
    expect(fromWireResponse(THREE, withAnswer("is_error", { type: "choice" }))).toMatchObject({
      ok: false,
    });
    expect(fromWireResponse(THREE, { answers: {} })).toMatchObject({ ok: false });
    expect(fromWireResponse(THREE, "not json")).toMatchObject({ ok: false });
  });
});

describe("errors (recorded)", () => {
  it("maps statuses and bodies to failure reasons", () => {
    expect(failureFromHttp(401, fixture("jev-error-401.json"))).toEqual({
      reason: "unauthorized",
      message:
        "authentication_error: Cannot authenticate with the server. Please check your API key and try again.",
    });
    expect(failureFromHttp(400, fixture("jev-error-400.json")).reason).toBe("model_not_found");
    expect(failureFromHttp(404, fixture("ollaya-error-model-not-found.json"))).toEqual({
      reason: "model_not_found",
      message: 'MODEL_NOT_FOUND: model "laya:nope" not found, try pulling it first',
    });
    expect(failureFromHttp(422, fixture("ollaya-error-invalid.json")).reason).toBe(
      "invalid_request",
    );
    expect(failureFromHttp(429, {}).reason).toBe("rate_limited");
    expect(failureFromHttp(529, {}).reason).toBe("overloaded");
    expect(failureFromHttp(503, { error: "busy", code: "QUEUE_FULL" }).reason).toBe("overloaded");
    expect(failureFromHttp(500, undefined)).toEqual({
      reason: "server_error",
      message: "HTTP 500",
    });
  });

  it("never repeats TypeSafe's echoed request (and its state) from a 422", () => {
    const body = fixture("jev-error-422.json");
    expect(errorMessage(body)).toBe("state: Field required");
    expect(JSON.stringify(failureFromHttp(422, body))).not.toContain("questions");
  });
});
