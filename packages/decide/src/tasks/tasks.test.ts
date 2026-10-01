import { EvidenceRefSchema } from "@optestra/contract";
import { describe, expect, it } from "vitest";
import { createDecisions, type Decided } from "../decide.js";
import { loadEvalSet } from "../node/evals.js";
import { createSystemOneBackend } from "../node/systemone/client.js";
import type { FetchLike } from "../node/systemone/transport.js";
import { factsFromLocator } from "./heal-class.js";
import { duplicateOrNew, failureCause, flakyOrReal, healClass } from "./index.js";

const decisions = createDecisions();
const TASKS = ["failure_cause", "flaky_or_real", "duplicate_or_new", "heal_class"] as const;
/** A committed eval case's input, by id (keeps these tests on realistic inputs). */
const input = (task: string, id: string) => {
  const found = loadEvalSet(task).find((c) => c.id === id);
  if (!found) throw new Error(`no eval case ${task}/${id}`);
  return found.input as never;
};
const decide = async (task: string, id: string) => decisions.decide(task, input(task, id));

describe("failure_cause rules", () => {
  it.each([
    ["shop-checkout-trial-broken-signup", "product_bug"], // 500 page on every attempt
    ["shop-create-project-env-flaky", "environment"], // 503 once, retry passed
    ["env-app-refused", "environment"],
    ["env-429", "environment"],
    ["data-email-exists", "test_data"],
    ["drift-button-renamed", "test_drift"],
    ["bug-js-crash", "product_bug"],
    ["bug-third-party-noise", "product_bug"], // another site's 503 is ignored
    ["shop-create-project-broken-silent-click", "product_bug"],
  ])("%s → %s", async (id, cause) => {
    expect(await decide("failure_cause", id)).toMatchObject({
      status: "decided",
      source: "rules",
      answers: { cause },
    });
  });

  it.each([
    "tricky-500-once-no-retry", // one 500 and no retry: bug or blip?
    "tricky-404-old-url", // a 404 page: broken link or removed URL?
    "tricky-check-flaky",
    "tricky-spinner",
  ])("escalates %s instead of guessing", async (id) => {
    expect(await decide("failure_cause", id)).toMatchObject({ status: "escalated" });
  });

  it("never offers `blocked`: that follows from a blocked reason, not a decision", () => {
    expect(failureCause.questions.cause.options).not.toContain("blocked");
  });
});

describe("flaky_or_real rules (advice only)", () => {
  it.each([
    ["shop-env-flaky", true],
    ["real-history-2", false],
    ["newly-broken-1", false],
    ["different-each-0", true],
    ["history-flips-2", true],
    ["same-no-history-0", false],
  ])("%s → intermittent %s", async (id, intermittent) => {
    expect(await decide("flaky_or_real", id)).toMatchObject({
      status: "decided",
      answers: { intermittent },
    });
  });

  it("escalates an outage that repeats on every attempt and a lone failure with no history", async () => {
    expect((await decide("flaky_or_real", "tricky-outage-both")).status).toBe("escalated");
    expect((await decide("flaky_or_real", "tricky-single-no-history")).status).toBe("escalated");
  });

  it("asks `intermittent`, never a verdict", () => {
    expect(Object.keys(flakyOrReal.questions)).toEqual(["intermittent"]);
  });
});

describe("duplicate_or_new rules", () => {
  it("offers the run's groups plus new, and puts login-flow failures in the login group", async () => {
    const i = input("duplicate_or_new", "shop-create-project-login-flow") as {
      groups: { id: string }[];
    };
    expect(duplicateOrNew.questionsFor?.(i as never).group).toMatchObject({
      options: ["g1", "g2", "new"],
    });
    expect(await decide("duplicate_or_new", "shop-create-project-login-flow")).toMatchObject({
      status: "decided",
      answers: { group: "g1" },
      evidence: [{ signal: "same_flow_step" }],
    });
  });

  it.each([
    ["first-failure", "new"],
    ["same-headline-route-3", "g1"], // numbers differ, same page
    ["match-with-id-route", "g1"], // /orders/9912 vs /orders/1204
    ["unrelated-search", "new"],
  ])("%s → %s", async (id, group) => {
    expect(await decide("duplicate_or_new", id)).toMatchObject({
      status: "decided",
      answers: { group },
    });
  });

  it("escalates a generic headline on another page", async () => {
    expect((await decide("duplicate_or_new", "tricky-generic-headline")).status).toBe("escalated");
  });

  it("refuses input-dependent options that would carry a verdict word", async () => {
    const bad = createDecisions({
      tasks: [
        {
          ...duplicateOrNew,
          name: "dup_bad",
          questionsFor: () => ({
            group: { ...duplicateOrNew.questions.group, options: ["passed", "new"] },
          }),
        },
      ],
    });
    const result = await bad.decide("dup_bad", input("duplicate_or_new", "first-failure"));
    expect(result).toMatchObject({ status: "escalated", reason: "invalid_input" });
  });
});

describe("heal_class rules", () => {
  it.each([
    ["fixture-add-to-bag", "cosmetic"], // cart/bag are synonyms
    ["same-name-css-0", "cosmetic"],
    ["case-punct-1", "cosmetic"],
    ["role-changed-0", "behavior_change"],
    ["opposite-0", "behavior_change"], // Save → Cancel
    ["different-verb-0", "behavior_change"], // Delete → Archive
    ["reworded-0", "cosmetic"], // Save → Save now
  ])("%s → %s", async (id, classification) => {
    expect(await decide("heal_class", id)).toMatchObject({
      status: "decided",
      answers: { classification },
    });
  });

  it.each(["tricky-delete-account", "tricky-wishlist", "tricky-blog-docs", "tricky-testid-only"])(
    "escalates %s instead of guessing",
    async (id) => {
      expect((await decide("heal_class", id)).status).toBe("escalated");
    },
  );

  it("reads element facts from Playwright-style locators", () => {
    expect(factsFromLocator("getByRole('button', { name: 'Add to cart' })")).toMatchObject({
      role: "button",
      name: "Add to cart",
    });
    expect(factsFromLocator('getByTestId("checkout")')).toMatchObject({
      testId: "checkout",
      role: null,
    });
    expect(factsFromLocator("getByText('Save')")).toMatchObject({ text: "Save" });
    expect(factsFromLocator("locator('button.primary')")).toMatchObject({ tag: "button" });
  });

  it("never answers `unknown` from the rules", async () => {
    for (const c of loadEvalSet("heal_class")) {
      const r = await decisions.decide("heal_class", c.input as never);
      if (r.status === "decided") expect(r.answers.classification).not.toBe("unknown");
    }
    expect(healClass.questions.classification.options).toContain("unknown");
  });
});

describe("every decided answer carries its evidence", () => {
  it("names at least one signal, with valid contract EvidenceRefs", async () => {
    for (const task of TASKS) {
      for (const c of loadEvalSet(task)) {
        const r = await decisions.decide(task, c.input as never);
        if (r.status !== "decided") continue;
        const decided = r as Decided;
        expect(decided.evidence.length, `${task}/${c.id}`).toBeGreaterThan(0);
        for (const e of decided.evidence) {
          expect(e.signal).toMatch(/^[a-z][a-z0-9_]*$/);
          if (e.ref) expect(EvidenceRefSchema.parse(e.ref)).toEqual(e.ref);
        }
      }
    }
  });

  it("points failure_cause evidence at the failing step or check", async () => {
    const r = await decide("failure_cause", "shop-checkout-trial-broken-total");
    expect(r.status === "decided" && r.evidence.map((e) => e.ref)).toContainEqual({
      kind: "check",
      attempt: 2,
      checkId: "c1",
    });
  });
});

describe("page and app text in states", () => {
  it("is marked untrusted", () => {
    const fc = failureCause.state(input("failure_cause", "data-email-exists"));
    expect(fc).toContain('<untrusted source="page-text">');
    expect(fc).toContain('<untrusted source="check-actual">');
    expect(fc).toContain(
      '<untrusted source="page-text">\nAn account with this email already exists.\n</untrusted>',
    );
    const dup = duplicateOrNew.state(input("duplicate_or_new", "shop-signup-email-code"));
    expect(dup).toContain('<untrusted source="this-failure">');
    const heal = healClass.state(input("heal_class", "opposite-0"));
    expect(heal).toContain('<untrusted source="element-before">');
    const flaky = flakyOrReal.state(input("flaky_or_real", "shop-env-flaky"));
    expect(flaky).toContain('<untrusted source="attempts">');
  });

  it("is redacted before it reaches a backend", async () => {
    const bodies: string[] = [];
    const recording: FetchLike = async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ answers: {} }), {
        headers: { "content-type": "application/json" },
      });
    };
    const backend = createSystemOneBackend({
      id: "jev",
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      flavor: "systemone",
      fetch: recording,
      scrub: (text) => text.replaceAll("sk-live-planted-4242", "[secret:API_KEY]"),
    });
    const withBackend = createDecisions({ backend, bypassCache: true });
    const base = input("failure_cause", "tricky-500-once-no-retry") as Record<string, unknown>;
    await withBackend.decide("failure_cause", {
      ...base,
      page: { status: 200, title: "Acme", heading: "Profile", text: "token: sk-live-planted-4242" },
    } as never);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("sk-live-planted-4242");
    expect(bodies[0]).toContain("[secret:API_KEY]");
  });
});
