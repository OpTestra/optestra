import type { CheckOp } from "@testament/recording";
import { describe, expect, it } from "vitest";
import {
  element,
  evaluation,
  fakeSession,
  promptText,
  scriptedModels,
} from "../author/test-kit.test-support.js";
import type { HarnessCheckOptions as CheckOptions, PageCopy } from "../target/harness.js";
import { compileCheck } from "./compile.js";
import { evaluateCheck } from "./evaluate.js";
import { sanityTest } from "./sanity.js";

const COPY = { url: "http://127.0.0.1:4100/before" } as unknown as PageCopy;
const where = (options: CheckOptions | undefined) =>
  options?.on === undefined || options.on === "page"
    ? "page"
    : options.on === "blank"
      ? "blank"
      : "before";

const page = [element("e1", "heading", "Welcome", { states: { level: 1 }, interactive: false })];

describe("sanity test (VER-6)", () => {
  const op: CheckOp = {
    type: "text",
    target: { kind: "css", selector: "body" },
    match: "contains",
    value: "Acme",
  };

  it("accepts a check that fails on the empty page and before the action", async () => {
    const session = fakeSession(page, undefined, (_op, options) =>
      evaluation(where(options) === "page"),
    );
    const sanity = await sanityTest(session, {
      op,
      values: {},
      now: evaluation(true),
      before: COPY,
    });
    expect(sanity).toEqual({
      empty: { result: "failed" },
      before: { result: "failed" },
      provesNothing: false,
    });
    expect(session.checked.map((c) => [where(c.options), c.options?.timeoutMs])).toEqual([
      ["blank", 0],
      ["before", 0],
    ]);
  });

  it("flags a check that passes on the empty page", async () => {
    const session = fakeSession(page, undefined, () => evaluation(true));
    const sanity = await sanityTest(session, { op, values: {}, now: evaluation(true) });
    expect(sanity).toMatchObject({ empty: { result: "passed" }, provesNothing: true });
    expect(sanity.before).toEqual({ result: "skipped", note: "No action before this check." });
  });

  it("flags a check that already passed before an action that changed what it looks at", async () => {
    const session = fakeSession(page, undefined, (_op, options) =>
      evaluation(where(options) !== "blank", { seen: where(options) }),
    );
    const sanity = await sanityTest(session, {
      op,
      values: {},
      now: evaluation(true, { seen: "page" }),
      before: COPY,
    });
    expect(sanity).toMatchObject({ before: { result: "passed" }, provesNothing: true });
  });

  it("skips the before-state when the action didn't change the check's subject", async () => {
    const session = fakeSession(page, undefined, (_op, options) =>
      evaluation(where(options) !== "blank", { seen: "same" }),
    );
    const sanity = await sanityTest(session, {
      op: { type: "url", match: "contains", value: "/checkout" },
      values: {},
      now: evaluation(true, { seen: "same" }),
      before: COPY,
    });
    expect(sanity).toEqual({
      empty: { result: "failed" },
      before: {
        result: "skipped",
        note: "The preceding action didn't change what this check looks at.",
      },
      provesNothing: false,
    });
  });

  it("doesn't use the empty page for absence checks, nor test soft judgments", async () => {
    const session = fakeSession(page, undefined, () => evaluation(true));
    const hidden = await sanityTest(session, {
      op: { type: "element_state", target: { kind: "text", text: "Error" }, state: "hidden" },
      values: {},
      now: evaluation(true),
    });
    expect(hidden.empty.result).toBe("skipped");
    const soft = await sanityTest(session, {
      op: { type: "soft_judgment", question: "looks fine", screenshot: "page" },
      values: {},
      now: evaluation(true),
    });
    expect(soft).toMatchObject({ provesNothing: false, empty: { result: "skipped" } });
  });
});

describe("compileCheck", () => {
  it("compiles by rules with no model, evaluates once and sanity-tests", async () => {
    const session = fakeSession(page, undefined, (_op, options) =>
      evaluation(where(options) === "page"),
    );
    const result = await compileCheck(
      { text: 'the page heading is "Welcome"', soft: false },
      { session, values: {}, before: COPY },
    );
    expect(result).toMatchObject({
      op: { type: "text", target: { kind: "role", role: "heading", level: 1 }, value: "Welcome" },
      generatedBy: "rules",
      rule: "heading",
      summary: "Checked that the main heading is exactly 'Welcome'",
      evaluation: { status: "passed" },
      sanity: { provesNothing: false },
      records: [],
    });
    expect(result.problem).toBeUndefined();
    // The authoring evaluation counts requests from the step's start (network checks).
    const evaluated = session.checked.find((c) => c.options?.timeoutMs === 5_000);
    expect(evaluated?.options?.since).toBe(COPY);
  });

  it("stays pending, with the reason, when no rule matches and no model is available", async () => {
    const result = await compileCheck(
      { text: "the chart looks reasonable", soft: false },
      { session: fakeSession(page), values: {} },
    );
    expect(result).toMatchObject({ op: { type: "pending" }, evaluation: null });
    expect(result.problem).toBe(
      "No phrase rule matches this line. No AI model is available to compile it.",
    );
  });

  it("never sends a line with a secret to the model", async () => {
    const { models, calls } = scriptedModels(() => ({ text: "{}" }));
    const result = await compileCheck(
      { text: 'the page shows "{{secret.X}}"', soft: false },
      { session: fakeSession(page), values: {}, models },
    );
    expect(result.op).toEqual({ type: "pending" });
    expect(calls).toHaveLength(0);
  });

  it("asks the AI compiler for lines rules can't map, with the page as untrusted content", async () => {
    const { models, calls } = scriptedModels(() => ({
      text: JSON.stringify({
        faithful: true,
        reason: "a heading",
        check: {
          type: "element_state",
          target: { kind: "role", role: "heading", name: "Welcome" },
          state: "visible",
        },
      }),
    }));
    const session = fakeSession(page, undefined, (_op, options) =>
      evaluation(where(options) === "page"),
    );
    const result = await compileCheck(
      { text: "we are greeted", soft: false },
      { session, values: {}, models, before: COPY },
    );
    expect(result).toMatchObject({
      generatedBy: "ai",
      op: { type: "element_state" },
      sanity: { provesNothing: false },
    });
    expect(result.records).toHaveLength(1);
    expect(promptText(calls[0] as never)).toContain("<<<PAGE CONTENT");
    expect(promptText(calls[0] as never)).toContain('Expectation (Expect: line): "we are greeted"');
  });

  it("refuses soft_judgment from the AI compiler on an Expect line (schema has no such option)", async () => {
    const { models } = scriptedModels(() => ({
      text: JSON.stringify({
        faithful: true,
        reason: "visual",
        check: { type: "soft_judgment", question: "q", screenshot: "page" },
      }),
    }));
    const result = await compileCheck(
      { text: "it looks right", soft: false },
      { session: fakeSession(page), values: {}, models },
    );
    expect(result.op).toEqual({ type: "pending" });
  });

  it("regenerates a check that proves nothing once, and flags it when that doesn't help", async () => {
    const { models, calls } = scriptedModels(() => ({
      text: JSON.stringify({ faithful: false, reason: "can't be more specific", check: null }),
    }));
    const session = fakeSession(page, undefined, (_op, options) =>
      evaluation(where(options) !== "blank", { seen: where(options) }),
    );
    const result = await compileCheck(
      { text: 'the page shows "Acme"', soft: false },
      { session, values: {}, models, before: COPY },
    );
    expect(result).toMatchObject({ generatedBy: "rules", sanity: { provesNothing: true } });
    expect(result.problem).toContain("before the preceding action");
    expect(calls).toHaveLength(1);
    expect(promptText(calls[0] as never)).toContain("A previous check was rejected");
  });

  it("takes the regenerated check when it passes the sanity test", async () => {
    const better: CheckOp = {
      type: "text",
      target: { kind: "role", role: "heading", level: 1 },
      match: "equals",
      value: "Acme",
    };
    const { models } = scriptedModels(() => ({
      text: JSON.stringify({ faithful: true, reason: "the heading", check: better }),
    }));
    const session = fakeSession(page, undefined, (op, options) => {
      const weak =
        (op as CheckOp).type === "text" &&
        (op as { target: { kind: string } }).target.kind === "css";
      return evaluation(where(options) === "page" || (weak && where(options) === "before"), {
        seen: where(options),
      });
    });
    const result = await compileCheck(
      { text: 'the page shows "Acme"', soft: false },
      { session, values: {}, models, before: COPY },
    );
    expect(result).toMatchObject({
      generatedBy: "ai",
      op: better,
      sanity: { provesNothing: false },
    });
    expect(result.rule).toBeUndefined();
    expect(result.problem).toBeUndefined();
  });
});

describe("evaluateCheck", () => {
  it("runs deterministic ops in the harness and soft judgments through a model, warn-only", async () => {
    const session = fakeSession(page, undefined, () => evaluation(true));
    const url: CheckOp = { type: "url", match: "contains", value: "/x" };
    expect(await evaluateCheck(session, url, { values: {} })).toMatchObject({ passed: true });
    expect(session.checked).toHaveLength(1);

    const soft: CheckOp = {
      type: "soft_judgment",
      question: "the chart looks reasonable",
      screenshot: "page",
    };
    expect(await evaluateCheck(session, soft)).toMatchObject({
      status: "unsupported",
      warnOnly: true,
    });
    const { models, calls } = scriptedModels(() => ({
      text: JSON.stringify({ answer: "no", reason: "the chart is empty" }),
    }));
    expect(await evaluateCheck(session, soft, { models })).toMatchObject({
      status: "failed",
      passed: false,
      warnOnly: true,
      expected: "the chart looks reasonable",
      actual: "no: the chart is empty",
    });
    expect(promptText(calls[0] as never)).toContain("untrusted content");
  });
});
