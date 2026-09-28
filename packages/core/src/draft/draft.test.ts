import { describe, expect, it } from "vitest";
import { element } from "../author/test-kit.test-support.js";
import { finishDraft } from "./draft.js";
import { labelOf, nameFromSentence, slugOf, stepText } from "./phrasing.js";
import { DRAFT_TOOLS, parseDraftCall } from "./tools.js";

// Drafting's pure parts: how actions read as steps, the closed tool set, and
// printing + lint of a draft. Exploring the shop is in e2e/draft.test.ts.

describe("stepText", () => {
  const button = element("e1", "button", "Log in");
  const field = element("e2", "textbox", "Email");
  it("writes steps from the element's label, the way the shop's tests read", () => {
    expect(stepText({ type: "click", element: button })).toBe('Click "Log in"');
    expect(stepText({ type: "fill", element: field, value: "ada@example.com" })).toBe(
      'Fill "Email" with ada@example.com',
    );
    expect(
      stepText({ type: "select", element: element("e3", "combobox", "Time zone"), option: "UTC" }),
    ).toBe('Select "UTC" in "Time zone"');
    expect(stepText({ type: "press", key: "Enter", element: field })).toBe(
      'Press Enter in "Email"',
    );
    expect(stepText({ type: "goto", url: "/settings" })).toBe("Go to /settings");
    expect(stepText({ type: "reload" })).toBe("Reload the page");
    expect(stepText({ type: "check", element: element("e4", "checkbox", "") })).toBe(
      "Check the checkbox",
    );
  });

  it("uses the text when there is no name, and never breaks the quotes", () => {
    expect(labelOf(element("e1", "link", "", { text: "  See   pricing " }))).toBe("See pricing");
    expect(stepText({ type: "click", element: element("e1", "button", 'Say "hi"') })).toBe(
      "Click \"Say 'hi'\"",
    );
  });
});

describe("names and paths", () => {
  it("slugs a test name into a file name", () => {
    expect(slugOf("Returning user can log in")).toBe("returning-user-can-log-in");
    expect(slugOf("Crème brûlée: pay & go!")).toBe("creme-brulee-pay-go");
    expect(slugOf("!!!")).toBe("draft");
    expect(slugOf("Logged-in user can create a project and see it in the projects list")).toBe(
      "logged-in-user-can-create-a-project",
    );
  });
  it("names a test from the sentence when the model gave none", () => {
    expect(nameFromSentence("a returning user can log in.")).toBe("A returning user can log in");
  });
});

describe("the drafter's tools", () => {
  it("are the closed action set plus expect and the two endings: no HTTP, code, files or inbox", () => {
    expect(DRAFT_TOOLS.map((t) => t.name)).toEqual([
      "click",
      "dblclick",
      "fill",
      "select",
      "check",
      "uncheck",
      "press",
      "hover",
      "scroll",
      "upload",
      "goto",
      "back",
      "reload",
      "wait_for",
      "look",
      "expect",
      "draft_done",
      "draft_impossible",
    ]);
  });
  it("parses and refuses tool calls", () => {
    expect(parseDraftCall("expect", { text: 'the page heading is "Dashboard"' })).toEqual({
      ok: true,
      call: { name: "expect", input: { text: 'the page heading is "Dashboard"' } },
    });
    expect(parseDraftCall("click", { ref: "e3" })).toMatchObject({ ok: true });
    expect(parseDraftCall("read_inbox", { want: "code" })).toEqual({
      ok: false,
      error: 'There is no tool "read_inbox".',
    });
    expect(parseDraftCall("step_done", {})).toMatchObject({ ok: false });
    expect(parseDraftCall("fetch", { url: "https://x" })).toMatchObject({ ok: false });
    expect(parseDraftCall("expect", { text: "  " })).toMatchObject({ ok: false });
    expect(parseDraftCall("click", { ref: "button" })).toMatchObject({ ok: false });
  });
});

describe("finishDraft", () => {
  it("prints the draft canonically and lints it", async () => {
    const done = await finishDraft({
      name: "New visitor can sign up",
      start: "/signup",
      path: "tests/new-visitor-can-sign-up.test.md",
      items: [
        { kind: "action", text: 'Fill "Email" with {{data.email}}' },
        { kind: "action", text: 'Click "Create account"' },
        {
          kind: "expect",
          text: 'the page heading is "Check your email"',
          check: { summary: "heading" },
        },
      ],
      data: { email: "unique.email" },
    });
    expect(done.text).toBe(`---
name: New visitor can sign up
start: /signup
data:
  email: "{{unique.email}}"
---

1. Fill "Email" with {{data.email}}
2. Click "Create account"
3. Expect: the page heading is "Check your email"
`);
    expect(done.lintClean).toBe(true);
    expect(done.spec.frontmatter.data.email?.raw).toBe("{{unique.email}}");
  });

  it("flags what lint finds: a draft with nothing checked is not clean", async () => {
    const done = await finishDraft({
      name: "Clicks around",
      start: "/",
      path: "tests/clicks-around.test.md",
      items: [{ kind: "action", text: 'Click "Pricing"' }],
      data: {},
    });
    expect(done.lintClean).toBe(false);
    expect(done.findings.map((f) => f.rule)).toContain("no-expectations");
  });
});
