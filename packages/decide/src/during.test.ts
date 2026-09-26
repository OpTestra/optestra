import { describe, expect, it } from "vitest";
import { createDecisions } from "./decide.js";
import {
  decideMiss,
  decideSameElement,
  type ElementFactsLike,
  type FingerprintLike,
  type LiveCandidate,
  missContext,
  rankCandidates,
} from "./during.js";
import { taskProblems } from "./guard.js";
import { loadEvalSet } from "./node/evals.js";
import { missAction } from "./tasks/miss-action.js";
import { sameElement, scoreSameElement } from "./tasks/same-element.js";

const decisions = createDecisions();

const recorded: FingerprintLike = {
  role: "button",
  name: "Start free trial",
  tag: "button",
  attributes: { type: "submit", class: "btn btn-primary" },
  anchorText: "Pro",
  framePath: [],
  box: { x: 420, y: 520, width: 220, height: 44 },
};
const facts = (patch: Partial<ElementFactsLike> = {}): ElementFactsLike => ({
  role: "button",
  name: "Start your free trial",
  tag: "button",
  attributes: { type: "submit", class: "button button--main" },
  text: "Start your free trial",
  anchorText: "Pro",
  framePath: [],
  box: { x: 420, y: 540, width: 240, height: 48 },
  ...patch,
});
const live = (
  patch: Partial<ElementFactsLike> = {},
  found: Partial<LiveCandidate> = {},
): LiveCandidate => ({
  facts: facts(patch),
  foundBy: "refind",
  matches: 1,
  ...found,
});

describe("same_element rules", () => {
  it("same: role, a reworded name and the same section (a cosmetic change)", async () => {
    const answer = await decideSameElement(recorded, live());
    expect(answer).toMatchObject({ same: true, decided: true, source: "rules" });
    expect(answer.evidence[0]).toMatchObject({ signal: "decided_same" });
  });

  it("same: a unique test id and role, even with new words and position", async () => {
    const fp = { ...recorded, anchorText: "Payment", attributes: { "data-testid": "pay-button" } };
    const answer = await decideSameElement(
      fp,
      live({
        name: "Complete purchase",
        anchorText: "Payment",
        attributes: { "data-testid": "pay-button" },
      }),
    );
    expect(answer.same).toBe(true);
  });

  it.each([
    ["a different role", { role: "link" }],
    ["a different frame", { framePath: [{ kind: "css", selector: "iframe" }] }],
    ["the opposite action", { name: "Stop free trial" }],
    [
      "a different section (the neighbouring plan card)",
      { name: "Start free trial", anchorText: "Starter" },
    ],
    ["a different name in a different section", { name: "Upload photo", anchorText: "Avatar" }],
  ])("not same: %s", async (_label, patch) => {
    expect(
      await decideSameElement(recorded, live(patch as Partial<ElementFactsLike>)),
    ).toMatchObject({
      same: false,
      decided: true,
    });
  });

  it("not same: a different kind of field, or a link to another page", async () => {
    const email = {
      ...recorded,
      role: "textbox",
      name: "Email",
      tag: "input",
      attributes: { type: "email" },
      anchorText: "Log in",
    };
    expect(
      (
        await decideSameElement(
          email,
          live({
            role: "textbox",
            name: "Password",
            tag: "input",
            attributes: { type: "password" },
            anchorText: "Log in",
          }),
        )
      ).same,
    ).toBe(false);
    const orders = {
      ...recorded,
      role: "link",
      name: "Orders",
      tag: "a",
      attributes: { href: "/orders" },
      anchorText: "Main",
    };
    expect(
      (
        await decideSameElement(
          orders,
          live({
            role: "link",
            name: "Settings",
            tag: "a",
            attributes: { href: "/settings" },
            anchorText: "Main",
          }),
        )
      ).same,
    ).toBe(false);
  });

  it("escalates what's in between: new words in the same section", async () => {
    const answer = await decideSameElement(
      { ...recorded, name: "Create", anchorText: "New project" },
      live({ name: "Save project", anchorText: "New project" }),
    );
    expect(answer).toMatchObject({ same: null, decided: false });
    expect(answer.evidence.map((e) => e.signal)).toContain("name");
  });

  it("escalates an ambiguous locator unless the candidate sits where the element was", async () => {
    const far = await decideSameElement(
      recorded,
      live({ box: { x: 420, y: 900, width: 220, height: 44 } }, { matches: 2 }),
    );
    expect(far.decided).toBe(false);
    const near = await decideSameElement(
      recorded,
      live({ box: { x: 422, y: 522, width: 220, height: 44 } }, { matches: 2 }),
    );
    expect(near.same).toBe(true);
  });

  it("does not trust a test id that several elements share", async () => {
    const fp = { ...recorded, name: "Launch plan", attributes: { "data-testid": "row" } };
    const answer = await decideSameElement(
      fp,
      live({ name: "Q3 roadmap", attributes: { "data-testid": "row" } }, { matches: 2 }),
    );
    expect(answer.same).not.toBe(true);
  });

  it("scores every signal with its weight (HEAL-6 evidence)", () => {
    const input = {
      recorded: { ...recorded, text: "", framePath: [] as Record<string, unknown>[] },
      candidate: {
        ...facts(),
        framePath: [] as Record<string, unknown>[],
        foundBy: "refind" as const,
        matches: 1,
      },
    };
    const s = scoreSameElement(input);
    expect(s.signals.map((x) => x.signal)).toEqual([
      "role",
      "name",
      "text",
      "test_id",
      "attributes",
      "anchor",
      "frame",
      "position",
    ]);
    expect(s.signals.find((x) => x.signal === "name")).toMatchObject({ score: 0.8, weight: 3 });
    expect(s.signals.find((x) => x.signal === "test_id")?.score).toBeNull();
    expect(s.combined).toBeGreaterThan(0.5);
  });
});

describe("same_element eval guarantees", () => {
  const cases = loadEvalSet("same_element");

  it("never says 'same' for a different element", async () => {
    for (const c of cases.filter((x) => x.expected === false)) {
      const r = await decisions.decide("same_element", c.input as never);
      if (r.status === "decided") expect(r.answers.same, c.id).toBe(false);
    }
  });

  it("never says 'not same' for a pure surface change from the shop's cosmetic build", async () => {
    const cosmetic = cases.filter((c) => c.id.startsWith("cosmetic-"));
    expect(cosmetic.length).toBeGreaterThanOrEqual(30);
    for (const c of cosmetic) {
      const r = await decisions.decide("same_element", c.input as never);
      if (r.status === "decided") expect(r.answers.same, c.id).toBe(true);
    }
  });

  it("decides every case with evidence", async () => {
    for (const task of ["same_element", "miss_action"]) {
      for (const c of loadEvalSet(task)) {
        const r = await decisions.decide(task, c.input as never);
        if (r.status === "decided") expect(r.evidence.length, c.id).toBeGreaterThan(0);
      }
    }
  });

  it("runs the rules path well under 1 ms per decision", async () => {
    const inputs = cases.map((c) => c.input);
    for (const input of inputs) await decisions.decide("same_element", input as never);
    const rounds = 10;
    const start = performance.now();
    for (let i = 0; i < rounds; i++)
      for (const input of inputs) await decisions.decide("same_element", input as never);
    expect((performance.now() - start) / (rounds * inputs.length)).toBeLessThan(1);
  });
});

describe("rankCandidates", () => {
  it("returns the one clear match", async () => {
    const result = await rankCandidates(recorded, [
      live({
        name: "Start your free trial",
        anchorText: "Starter",
        box: { x: 740, y: 540, width: 240, height: 48 },
      }),
      live(),
      live({
        name: "Start your free trial",
        anchorText: "Team",
        box: { x: 100, y: 540, width: 240, height: 48 },
      }),
    ]);
    expect(result.outcome).toBe("match");
    expect(result.best?.index).toBe(1);
    expect(result.ranked[0]?.index).toBe(1);
  });

  it("calls two 'same' candidates ambiguous, never a random pick", async () => {
    const result = await rankCandidates(recorded, [
      live(),
      live({ box: { x: 421, y: 541, width: 240, height: 48 } }),
    ]);
    expect(result).toMatchObject({ outcome: "ambiguous", best: null });
  });

  it("needs the best to be clearly ahead by the margin", async () => {
    const candidates = [live(), live({ name: "Start trial", anchorText: "Pro" })];
    // With an impossible margin even a lone "same" isn't clear enough.
    expect((await rankCandidates(recorded, candidates, { margin: 2 })).outcome).toBe("ambiguous");
  });

  it("returns none when nothing is decided same, and for no candidates", async () => {
    expect((await rankCandidates(recorded, [live({ role: "link" })])).outcome).toBe("none");
    expect((await rankCandidates(recorded, [])).outcome).toBe("none");
  });
});

describe("miss_action: the healing ladder", () => {
  const ctx = (patch: Record<string, unknown> = {}) =>
    ({
      missReason: "not_found",
      refusal: null,
      usedElement: null,
      fallbacks: { total: 2, matched: 0, sameElement: null },
      ranking: { outcome: "none", bestScore: 0.1 },
      page: { isError: false, appDown: false, serverErrors: 0, networkFailures: 0 },
      policy: "review",
      budgetLeftUsd: 1,
      fixerAvailable: true,
      ...patch,
    }) as never;

  it.each([
    [
      "an error page",
      {
        page: { isError: true, appDown: false, serverErrors: 0, networkFailures: 0 },
        fallbacks: { total: 1, matched: 1, sameElement: "same" },
      },
      "block",
      "app_down",
    ],
    [
      "a refused action",
      { missReason: "action_refused", refusal: "missing_secret" },
      "block",
      "missing_secret",
    ],
    [
      "the right element did nothing",
      { missReason: "post_state_mismatch", usedElement: "same" },
      "no_heal",
      null,
    ],
    [
      "a fallback matched the same element",
      { fallbacks: { total: 2, matched: 1, sameElement: "same" } },
      "replay_fallback",
      null,
    ],
    ["a clear re-find", { ranking: { outcome: "match", bestScore: 0.9 } }, "refind", null],
    ["strict policy, nothing without AI", { policy: "strict" }, "no_heal", null],
    ["fixer available", {}, "call_fixer", null],
    ["no fixer model", { fixerAvailable: false }, "block", "ai_unavailable"],
    ["budget spent", { budgetLeftUsd: 0 }, "block", "budget_exceeded"],
  ])("%s → %s", async (_label, patch, action, blockedReason) => {
    expect(await decideMiss(ctx(patch))).toMatchObject({ action, decided: true, blockedReason });
  });

  it("never replays a fallback that matched a different element", async () => {
    expect(
      (await decideMiss(ctx({ fallbacks: { total: 1, matched: 1, sameElement: "not_same" } })))
        .action,
    ).toBe("call_fixer");
  });

  it("builds its input from the helpers' outputs", async () => {
    const rank = await rankCandidates(recorded, [live()]);
    const input = missContext({
      missReason: "not_found",
      refusal: null,
      usedElement: null,
      fallbacks: { total: 1, matched: 0 },
      rank,
      page: { isError: false, appDown: false, serverErrors: 0, networkFailures: 0 },
      policy: "auto",
      budgetLeftUsd: null,
      fixerAvailable: false,
    });
    expect(input.ranking.outcome).toBe("match");
    expect((await decideMiss(input)).action).toBe("refind");
  });
});

describe("no verdicts", () => {
  it("both tasks pass the no-verdict guard, and `fail` is not an action", () => {
    expect(taskProblems(sameElement)).toEqual([]);
    expect(taskProblems(missAction)).toEqual([]);
    expect(missAction.questions.action.options).not.toContain("fail");
  });
});
