import { describe, expect, it } from "vitest";
import {
  bindCheck,
  type CheckOp,
  type CheckOpType,
  type CheckRecording,
  CheckRecordingSchema,
  describeCheck,
  parseRecording,
} from "./index.js";

const PROJECTS = { kind: "role", role: "list", name: "Projects", exact: true } as const;

/** One op of every type, and its summary (EVD-3). */
const SUMMARIES: Array<[CheckOp, string]> = [
  [
    {
      type: "text",
      target: { kind: "role", role: "heading", level: 1 },
      match: "equals",
      value: "Welcome to Pro",
    },
    "Checked that the main heading is exactly 'Welcome to Pro'",
  ],
  [
    {
      type: "text",
      target: { kind: "css", selector: "body" },
      match: "contains",
      value: "$0.00 due today",
    },
    "Checked that the page shows '$0.00 due today'",
  ],
  [
    { type: "text", target: PROJECTS, match: "contains", value: "Q3 roadmap" },
    "Checked that the list 'Projects' contains 'Q3 roadmap'",
  ],
  [
    {
      type: "text",
      target: { kind: "css", selector: "tbody tr:visible", nth: 0 },
      match: "matches",
      value: "A-1002[\\s\\S]*\\$8\\.90",
      scope: { kind: "role", role: "table", name: "Your orders", exact: true },
    },
    "Checked that the text of the first data row in the table 'Your orders' matches the pattern /A-1002[\\s\\S]*\\$8\\.90/",
  ],
  [
    { type: "url", match: "contains", value: "/dashboard" },
    "Checked that the URL contains '/dashboard'",
  ],
  [{ type: "url", match: "is", value: "/settings" }, "Checked that the URL is '/settings'"],
  [
    {
      type: "element_state",
      target: { kind: "role", role: "dialog", name: "New project", exact: true },
      state: "visible",
    },
    "Checked that the dialog 'New project' is visible",
  ],
  [
    {
      type: "element_state",
      target: { kind: "role", role: "img", name: "Your avatar" },
      state: "hidden",
    },
    "Checked that the image 'Your avatar' is not visible",
  ],
  [
    {
      type: "count",
      target: { kind: "css", selector: "tbody tr:visible" },
      n: 5,
      scope: { kind: "role", role: "table", name: "Your orders", exact: true },
    },
    "Checked that there are exactly 5 visible data rows in the table 'Your orders'",
  ],
  [
    { type: "count", target: { kind: "role", role: "listitem" }, min: 1, scope: PROJECTS },
    "Checked that there are at least 1 list items in the list 'Projects'",
  ],
  [
    {
      type: "value",
      target: { kind: "label", text: "Full name", exact: true },
      match: "contains",
      value: "Ada King",
    },
    "Checked that the field labelled 'Full name' contains 'Ada King'",
  ],
  [
    {
      type: "value",
      target: { kind: "label", text: "Time zone" },
      match: "equals",
      value: "Europe/London",
    },
    "Checked that the field labelled 'Time zone' has the value 'Europe/London'",
  ],
  [
    { type: "network", method: "post", url: "/api/projects", status: 201 },
    "Checked that a POST request to /api/projects was sent and answered 201",
  ],
  [
    { type: "aria_snapshot", target: PROJECTS, snapshot: "- listitem: Q3 roadmap" },
    "Checked that the accessibility tree of the list 'Projects' matches the saved snapshot",
  ],
  [
    { type: "code", code: "await expect(page).toHaveTitle(/Shop/);" },
    "Ran the test's own Playwright check code",
  ],
  [
    { type: "soft_judgment", question: "the chart looks reasonable", screenshot: "page" },
    "Asked an AI model to judge a screenshot of the page: 'the chart looks reasonable' (soft check: it can only warn)",
  ],
  [{ type: "pending" }, "Not checked: this expectation has no compiled check yet"],
];

describe("describeCheck (EVD-3)", () => {
  it("has one plain sentence for every op type", () => {
    const types = new Set<CheckOpType>(SUMMARIES.map(([op]) => op.type));
    expect([...types].sort()).toEqual([
      "aria_snapshot",
      "code",
      "count",
      "element_state",
      "network",
      "pending",
      "soft_judgment",
      "text",
      "url",
      "value",
    ]);
    for (const [op, summary] of SUMMARIES) expect(describeCheck(op)).toBe(summary);
  });

  it("describes frames and other locators", () => {
    expect(
      describeCheck({
        type: "value",
        target: {
          kind: "label",
          text: "Card number",
          frame: [{ kind: "title", text: "Secure card payment" }],
        },
        match: "equals",
        value: "4242",
      }),
    ).toBe(
      "Checked that the field labelled 'Card number' inside the frame element titled 'Secure card payment' has the value '4242'",
    );
    expect(
      describeCheck({
        type: "element_state",
        target: { kind: "role", role: "status" },
        state: "visible",
      }),
    ).toBe("Checked that a status message is visible");
  });
});

const check = (fields: Partial<CheckRecording>): unknown => ({
  key: "0123456789abcdef",
  textKey: "t",
  text: "the chart looks reasonable",
  soft: true,
  check: { type: "soft_judgment", question: "the chart looks reasonable", screenshot: "page" },
  generatedBy: "ai",
  recordedAt: "2026-01-01T00:00:00.000Z",
  ...fields,
});

describe("check recording schema", () => {
  it("allows soft_judgment only on soft lines (VER-3)", () => {
    expect(CheckRecordingSchema.safeParse(check({})).success).toBe(true);
    const hard = CheckRecordingSchema.safeParse(check({ soft: false }));
    expect(hard.success).toBe(false);
    expect(hard.error?.issues[0]?.message).toContain("only allowed on Soft: lines");
    expect(
      CheckRecordingSchema.safeParse(
        check({ check: { type: "soft_judgment", question: "q", screenshot: "element" } }),
      ).success,
    ).toBe(false);
  });

  it("takes the LOOP-2 fields and still reads LOOP-1 checks", () => {
    const full = check({
      soft: false,
      text: 'the page heading is "Dashboard"',
      check: {
        type: "text",
        target: { kind: "role", role: "heading", level: 1 },
        match: "equals",
        value: "Dashboard",
      },
      generatedBy: "rules",
      rule: "heading",
      summary: "Checked that the main heading is exactly 'Dashboard'",
      sanity: {
        empty: { result: "failed" },
        before: { result: "skipped", note: "No action before this check." },
        provesNothing: false,
      },
      failedAtAuthoring: { expected: "Dashboard", actual: "Log in" },
    });
    expect(CheckRecordingSchema.safeParse(full).success).toBe(true);
    const loop1 = check({ soft: false, check: { type: "pending" }, generatedBy: "ai" });
    expect(CheckRecordingSchema.safeParse(loop1).success).toBe(true);
    expect(parseRecording("{}").ok).toBe(false);
  });
});

describe("bindCheck", () => {
  it("binds references, and refuses secrets and missing values", () => {
    expect(
      bindCheck(
        {
          type: "text",
          target: { kind: "css", selector: "body" },
          match: "contains",
          value: "Hi {{data.name}}",
        },
        { "data.name": "Ada" },
      ),
    ).toMatchObject({ ok: true, op: { value: "Hi Ada" } });
    expect(bindCheck({ type: "url", match: "contains", value: "{{secret.X}}" })).toMatchObject({
      ok: false,
      reason: "secret",
    });
    expect(bindCheck({ type: "url", match: "contains", value: "{{env.X}}" })).toMatchObject({
      ok: false,
      reason: "unresolved",
    });
  });

  it("escapes substituted values in regex checks and keeps literal braces", () => {
    expect(
      bindCheck(
        { type: "url", match: "matches", value: "^/orders/{{data.id}}$" },
        { "data.id": "a.1" },
      ),
    ).toMatchObject({ op: { value: "^/orders/a\\.1$" } });
    expect(
      bindCheck({
        type: "text",
        target: { kind: "css", selector: "body" },
        match: "contains",
        value: "\\{{x}}",
      }),
    ).toMatchObject({ op: { value: "{{x}}" } });
  });
});
