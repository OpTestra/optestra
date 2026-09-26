import { defaultRegistry } from "@testament/config";
import { describe, expect, it } from "vitest";
import {
  type BackendResponse,
  createDecisions,
  type DecisionMeta,
  type DecisionsSettings,
  mockBackend,
} from "./index.js";

const settings = (patch: Partial<DecisionsSettings> = {}) => ({
  decisions: { ...(defaultRegistry.defaults().decisions as DecisionsSettings), ...patch },
});
const unclearPage = { status: 403, title: "Acme", heading: "", text: "Please sign in." };
const unclearHeal = {
  before: {
    locator: "",
    role: "link",
    name: "Pricing",
    text: null,
    tag: null,
    testId: null,
    position: null,
  },
  after: {
    locator: "",
    role: "link",
    name: "Plans",
    text: null,
    tag: null,
    testId: null,
    position: null,
  },
  changes: [{ target: "locator", before: "a", after: "b" }],
  signals: [],
  attempt: 1,
  stepIndex: 2,
};
const answerAll = (request: {
  questions: Record<string, { kind: string; options?: readonly string[] }>;
}): BackendResponse => ({
  ok: true,
  answers: Object.fromEntries(
    Object.entries(request.questions).map(([id, q]) => [
      id,
      q.kind === "noul"
        ? { kind: "noul", value: true, confidence: 0.95 }
        : { kind: "choice", value: q.options?.[0] ?? "", confidence: 0.95 },
    ]),
  ),
});

describe("per-phase routing", () => {
  it("sends each task to its phase's backend", async () => {
    const during = mockBackend({ id: "laya", respond: answerAll as never });
    const after = mockBackend({ id: "jev", respond: answerAll as never });
    const decisions = createDecisions({ backends: { during, after }, bypassCache: true });
    expect(await decisions.decide("page_is_error", unclearPage)).toMatchObject({ source: "laya" });
    expect(await decisions.decide("heal_class", unclearHeal as never)).toMatchObject({
      source: "jev",
    });
    expect([during.calls.length, after.calls.length]).toEqual([1, 1]);
    expect(decisions.backends).toEqual({ during, after });
  });

  it("batches after-run decisions per backend, all at once", async () => {
    const during = mockBackend({ id: "laya", respond: answerAll as never });
    const after = mockBackend({ id: "jev", respond: answerAll as never });
    const decisions = createDecisions({ backends: { during, after }, bypassCache: true });
    const results = await decisions.decideBatch([
      { task: "page_is_error", input: unclearPage },
      { task: "heal_class", input: unclearHeal },
      {
        task: "heal_class",
        input: { ...unclearHeal, after: { ...unclearHeal.after, name: "Plans & pricing" } },
      },
    ]);
    expect(results.map((r) => r.status)).toEqual(["decided", "decided", "decided"]);
    expect(during.calls).toHaveLength(1);
    expect(after.calls).toHaveLength(1);
    expect(Object.keys(after.calls[0]?.questions ?? {})).toEqual([
      "1.classification",
      "2.classification",
    ]);
  });

  it("`backend` alone serves both phases", async () => {
    const both = mockBackend({ respond: answerAll as never });
    const decisions = createDecisions({ backend: both, bypassCache: true });
    expect(decisions.backends).toEqual({ during: both, after: both });
  });
});

describe("latency-aware skipping (routing never slows a run)", () => {
  it("never calls a backend whose expected latency is above the task's limit", async () => {
    const slow = Object.assign(mockBackend({ id: "jev", respond: answerAll as never }), {
      expectedLatencyMs: 400,
    });
    const metas: DecisionMeta[] = [];
    const decisions = createDecisions({
      backend: slow,
      bypassCache: true,
      onDecision: (_r, m) => metas.push(m),
    });
    const during = await decisions.decide("page_is_error", unclearPage); // 100 ms limit
    expect(during).toMatchObject({
      status: "escalated",
      reason: "undecided",
      backend: { skipped: "too_slow" },
    });
    expect(slow.calls).toHaveLength(0);
    expect(metas[0]?.backend).toEqual({ skipped: "too_slow" });
    // The same backend is fine for a 2 s after-run task.
    expect(await decisions.decide("heal_class", unclearHeal as never)).toMatchObject({
      source: "jev",
    });
    expect(decisions.metrics().page_is_error?.backendSkipped).toEqual({ too_slow: 1, timeouts: 0 });
  });

  it("stops calling a backend for a task after N timeouts in the run", async () => {
    const hanging = mockBackend({ id: "laya", delayMs: 500, respond: answerAll as never });
    const decisions = createDecisions({
      config: settings({ skipAfterTimeouts: 3, tasks: { page_is_error: { timeLimitMs: 20 } } }),
      backend: hanging,
      bypassCache: true,
    });
    const reasons: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await decisions.decide("page_is_error", unclearPage);
      reasons.push(
        r.status === "escalated"
          ? `${r.reason}${r.backend?.skipped ? `:${r.backend.skipped}` : ""}`
          : r.status,
      );
    }
    expect(reasons).toEqual([
      "timeout",
      "timeout",
      "timeout",
      "undecided:timeouts",
      "undecided:timeouts",
    ]);
    expect(hanging.calls).toHaveLength(3);
    expect(decisions.metrics().page_is_error).toMatchObject({
      backendSkipped: { too_slow: 0, timeouts: 2 },
    });
    // Other tasks still use it.
    expect(await decisions.decide("heal_class", unclearHeal as never)).toMatchObject({
      source: "laya",
    });
  });
});
