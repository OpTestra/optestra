import { readdirSync, readFileSync } from "node:fs";
import type { CheckOp } from "@optestra/recording";
import { describe, expect, it } from "vitest";
import type { Observation } from "../target/harness.js";
import { compileByRules, matchRules, namesMatch, type Probe } from "./rules.js";

// The rule compiler against saved observations of the shop pages (captured by
// e2e/checks.test.ts with UPDATE_CHECK_FIXTURES=1): every Expect line in the
// shop suite compiles by rules, with no model, to the expected op.

interface Capture {
  test: string;
  line: string;
  observation: Observation;
  probes: Record<string, { passed: boolean; matched?: number }>;
  op: CheckOp;
}

const captures = JSON.parse(
  readFileSync(new URL("../../fixtures/checks/shop-correct.json", import.meta.url), "utf8"),
) as Capture[];

const probeKey = (op: unknown): string =>
  JSON.stringify(op, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );

/** Answers probes from the capture; a probe that was never made live is a test failure. */
const replay =
  (capture: Capture): Probe =>
  async (op) => {
    const answer = capture.probes[probeKey(op)];
    if (!answer) throw new Error(`probe not captured for ${capture.line}: ${probeKey(op)}`);
    return answer;
  };

const H1 = { kind: "role", role: "heading", level: 1 } as const;
const PAGE = { kind: "css", selector: "body" } as const;
const STATUS = { kind: "role", role: "status" } as const;
const PROJECTS = { kind: "role", role: "list", name: "Projects", exact: true } as const;
const ORDERS = { kind: "role", role: "table", name: "Your orders", exact: true } as const;
const ROWS = { kind: "css", selector: "tbody tr:visible" } as const;
const heading = (value: string): CheckOp => ({ type: "text", target: H1, match: "equals", value });
const shows = (value: string): CheckOp => ({
  type: "text",
  target: PAGE,
  match: "contains",
  value,
});
const status = (value: string): CheckOp => ({
  type: "text",
  target: STATUS,
  match: "contains",
  value,
});
const visible = (role: string, name: string): CheckOp => ({
  type: "element_state",
  target: { kind: "role", role, name, exact: true },
  state: "visible",
});

/** Every distinct Expect line of the shop suite, and the op it must compile to. */
const EXPECTED: Record<string, CheckOp> = {
  'the page heading is "Dashboard"': heading("Dashboard"),
  'the page heading is "Check your email"': heading("Check your email"),
  'the page heading is "Welcome to Pro"': heading("Welcome to Pro"),
  'the page heading is "Acme Shop"': heading("Acme Shop"),
  'the page heading is "Create your account"': heading("Create your account"),
  "the URL contains /dashboard": { type: "url", match: "contains", value: "/dashboard" },
  "the URL contains /checkout": { type: "url", match: "contains", value: "/checkout" },
  'the page shows "Pro plan"': shows("Pro plan"),
  'the page shows "$0.00 due today"': shows("$0.00 due today"),
  'the text "Enter a valid email address, like name@example.com." is shown': shows(
    "Enter a valid email address, like name@example.com.",
  ),
  'the text "Password must be at least 8 characters." is shown': shows(
    "Password must be at least 8 characters.",
  ),
  'a message says "Avatar updated"': status("Avatar updated"),
  'a message says "Project created"': status("Project created"),
  'a message says "Profile saved"': status("Profile saved"),
  'an error says "Your card was declined."': {
    type: "text",
    target: { kind: "role", role: "alert" },
    match: "contains",
    value: "Your card was declined.",
  },
  'a dialog titled "New project" is open': visible("dialog", "New project"),
  'a "Delete account" button is shown': visible("button", "Delete account"),
  'the image "Your avatar" is visible': visible("img", "Your avatar"),
  'the projects list shows "Q3 roadmap"': {
    type: "text",
    target: PROJECTS,
    match: "contains",
    value: "Q3 roadmap",
  },
  'the projects list says "No projects yet."': {
    type: "text",
    target: PROJECTS,
    match: "contains",
    value: "No projects yet.",
  },
  "the orders table shows 5 orders": { type: "count", target: ROWS, n: 5, scope: ORDERS },
  "the orders table shows 6 orders": { type: "count", target: ROWS, n: 6, scope: ORDERS },
  "the first order in the table is A-1002 ($8.90)": {
    type: "text",
    target: { ...ROWS, nth: 0 },
    match: "matches",
    value: "A-1002[\\s\\S]*\\$8\\.90",
    scope: ORDERS,
  },
  "the first order in the table is A-1004 ($150.00)": {
    type: "text",
    target: { ...ROWS, nth: 0 },
    match: "matches",
    value: "A-1004[\\s\\S]*\\$150\\.00",
    scope: ORDERS,
  },
  '"Full name" contains "Ada King"': {
    type: "value",
    target: { kind: "label", text: "Full name", exact: true },
    match: "contains",
    value: "Ada King",
  },
  '"Time zone" is "Europe/London"': {
    type: "value",
    target: { kind: "label", text: "Time zone", exact: true },
    match: "equals",
    value: "Europe/London",
  },
};

describe("rule compiler on the shop's saved pages", () => {
  it("has a capture for all 26 distinct Expect lines of the shop suite", () => {
    expect(captures.map((c) => c.line).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(captures.map((c) => [c.line, c]))("compiles %s by rules", async (_line, capture) => {
    const line = capture.line;
    const result = await compileByRules(line, {
      observation: capture.observation,
      probe: replay(capture),
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.op).toEqual(EXPECTED[line]);
    // What the live authoring run stored is the same op.
    expect(result.op).toEqual(capture.op);
    // The line is never changed.
    expect(capture.line).toBe(line);
  });
});

const EMPTY: Observation = {
  untrusted: true,
  url: "http://shop.test/",
  title: "",
  observedAt: "",
  frames: [{ url: "http://shop.test/", parentRef: null }],
  elements: [],
  refused: [],
  truncated: false,
};
const none: Probe = async () => ({ passed: false, matched: 0 });
const all: Probe = async () => ({ passed: true, matched: 1 });
const compile = (line: string, probe: Probe = none, observation = EMPTY) =>
  compileByRules(line, { observation, probe });

describe("rule compiler phrases", () => {
  it("maps URL phrasings", async () => {
    expect(await compile('the URL is "/settings"')).toMatchObject({
      op: { type: "url", match: "is", value: "/settings" },
    });
    expect(await compile("the URL ends with /done")).toMatchObject({
      op: { type: "url", match: "matches", value: "/done$" },
    });
    expect(await compile("the URL starts with /orders")).toMatchObject({
      op: { type: "url", match: "matches", value: "^[a-z]+://[^/]+/orders" },
    });
    expect(await compile("we are on /dashboard")).toMatchObject({
      op: { type: "url", match: "is", value: "/dashboard" },
    });
  });

  it("falls back to any heading when the page has no h1", async () => {
    expect(await compile('the page heading is "Hi"')).toMatchObject({
      op: { target: { kind: "role", role: "heading" }, match: "equals", value: "Hi" },
    });
  });

  it("maps element states and roles from the phrase data", async () => {
    expect(await compile('the "Save" button is disabled')).toMatchObject({
      op: { type: "element_state", target: { role: "button", name: "Save" }, state: "disabled" },
    });
    expect(await compile('the checkbox "Remember me" is not checked')).toMatchObject({
      op: { target: { role: "checkbox", name: "Remember me" }, state: "unchecked" },
    });
    expect(await compile('the "Help" link is hidden')).toMatchObject({
      op: { target: { role: "link" }, state: "hidden" },
    });
    expect(await compile('the page doesn\'t show "Error"')).toMatchObject({
      op: {
        type: "element_state",
        target: { kind: "text", text: "Error", exact: false },
        state: "hidden",
      },
    });
  });

  it("accepts curly quotes and a capital first letter", async () => {
    expect(await compile("The page shows “Saved”")).toMatchObject({
      op: { type: "text", target: PAGE, value: "Saved" },
    });
  });

  it("keeps {{refs}} as templates in check values", async () => {
    expect(await compile('the page shows "{{data.email}}"')).toMatchObject({
      op: { value: "{{data.email}}" },
    });
  });

  it("never compiles a line that uses a secret", async () => {
    expect(await compile('the page shows "{{secret.SHOP_PASSWORD}}"')).toMatchObject({
      ok: false,
      reason: "secret",
    });
  });

  it("falls back from the label to the field's role", async () => {
    const probe: Probe = async (op) =>
      op.type === "count" && op.target.kind === "role" && op.target.role === "combobox"
        ? { passed: true, matched: 1 }
        : { passed: true, matched: 0 };
    expect(await compile('"Country" is "France"', probe)).toMatchObject({
      op: { type: "value", target: { kind: "role", role: "combobox", name: "Country" } },
    });
  });

  it("an error that isn't on the page keeps its faithful form, so it fails and is shown", async () => {
    expect(await compile('an error says "Oops"')).toMatchObject({
      op: { target: { kind: "role", role: "alert" }, value: "Oops" },
    });
  });

  it("a message not in a status or alert region is checked as visible text", async () => {
    const probe: Probe = async (op) => ({
      passed: op.type === "text" && op.target.kind === "css",
      matched: 1,
    });
    expect(await compile('a message says "Done"', probe)).toMatchObject({
      op: { target: PAGE, value: "Done" },
    });
  });

  it("finds a list or table only when the page has it, and says so otherwise", async () => {
    const result = await compile('the projects list shows "Q3"');
    expect(result).toMatchObject({ ok: false, reason: "no_rule", tried: ["container-text"] });
    const withList = await compile('the projects list shows "Q3"', all);
    expect(withList).toMatchObject({ op: { target: { kind: "role", role: "list" } } });
    expect(await compile("the second item in the todo list is Milk", all)).toMatchObject({
      op: { type: "text", target: { role: "listitem", nth: 1 }, match: "contains", value: "Milk" },
    });
  });

  it("reports lines no rule matches", async () => {
    expect(await compile("the chart looks reasonable")).toMatchObject({
      ok: false,
      reason: "no_rule",
      tried: [],
      message: "No phrase rule matches this line.",
    });
    expect(matchRules("the chart looks reasonable")).toEqual([]);
  });

  it("matches nouns to names, singular or plural", () => {
    expect(namesMatch("projects", "Projects")).toBe(true);
    expect(namesMatch("orders", "Your orders")).toBe(true);
    expect(namesMatch("orders", "Projects")).toBe(false);
  });
});

describe("Android app screens (MOB-1)", () => {
  const dir = new URL("../../../../bench/fixtures/android/tests/", import.meta.url);
  const lines = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".test.md"))
    .flatMap((f) =>
      [...readFileSync(new URL(f, dir), "utf8").matchAll(/^\d+\. Expect: (.+)$/gm)].map(
        (m) => m[1] ?? "",
      ),
    );

  it("has a phrase rule for every Expect line of the Android fixture", () => {
    expect(lines.length).toBeGreaterThan(8);
    for (const line of lines) expect(matchRules(line), line).not.toEqual([]);
  });

  it("reads screen, toast and dialog wording", () => {
    const first = (line: string) => matchRules(line)[0]?.rule.id;
    expect(first('the screen heading is "Projects"')).toBe("heading");
    expect(first('the screen says "Saved"')).toBe("visible-text");
    expect(first('a toast says "Project created"')).toBe("message");
    expect(first('a dialog asks "Sign out?"')).toBe("dialog");
    expect(first('the list shows "Q3 roadmap"')).toBe("container-text");
  });
});

describe("terse and pasted phrasings (COST-0 corpus)", () => {
  const first = (line: string) => matchRules(line)[0]?.rule.id;

  it("reads a developer's shorthand", () => {
    expect(first('page shows "$0.00 due today"')).toBe("visible-text");
    expect(first('"$0.00 due today"')).toBe("visible-text");
    expect(first('heading "Welcome to Pro"')).toBe("heading");
    expect(first('heading still "Create your account"')).toBe("heading");
    expect(first("url contains /dashboard")).toBe("url");
    expect(first("url /dashboard")).toBe("url");
    expect(first("still on /checkout")).toBe("url");
    expect(first('toast "Project created"')).toBe("message");
    expect(first('"Project created" message')).toBe("message");
    expect(first('error "Your card was declined."')).toBe("error");
    expect(first('image "Your avatar" visible')).toBe("element");
    expect(first('list has "Website redesign"')).toBe("container-text");
  });

  it("ignores a bracketed remark after the quoted value", () => {
    expect(first('the page shows "$0.00 due today" (a trial must not charge anything)')).toBe(
      "visible-text",
    );
    expect(
      matchRules('the page shows "$0.00 due today" (a trial must not charge anything)')[0]?.groups
        .text,
    ).toBe("$0.00 due today");
  });

  it("keeps the new shapes narrow", () => {
    // A bare quoted line is only one quoted value, never a field and its value.
    expect(first('"Full name" contains "Ada King"')).toBe("field-value");
    expect(matchRules('"Full name" contains "Ada King"').map((m) => m.rule.id)).not.toContain(
      "visible-text",
    );
    expect(matchRules("heading check your email")).toEqual([]);
    expect(matchRules("still in the list")).toEqual([]);
  });

  it("compiles the shorthand to the same check as the tidy line", async () => {
    const seen: Probe = async () => ({ passed: true, matched: 1 });
    const tidy = await compile('the page shows "Nothing to see"', seen);
    const terse = await compile('"Nothing to see"', seen);
    expect(terse).toMatchObject({ ok: true, rule: "visible-text" });
    expect(terse.ok && tidy.ok ? terse.op : null).toEqual(tidy.ok ? tidy.op : undefined);
  });
});
