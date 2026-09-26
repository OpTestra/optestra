import { describe, expect, it } from "vitest";
import {
  checkKey,
  parseRecording,
  RECORDING_EPOCH,
  type Recording,
  routeOf,
  serializeRecording,
  stepKey,
  templateParts,
  templateRefs,
  toTemplate,
} from "./index.js";

const recording: Recording = {
  recordingVersion: 1,
  testId: "tests__login",
  testPath: "tests/login.test.md",
  target: "web",
  recordedWith: {
    engineVersion: "0.1.0",
    epoch: RECORDING_EPOCH,
    browser: "chromium",
    device: "desktop",
    environment: "local",
    model: "anthropic/claude-sonnet-5",
    promptVersion: "planner-v1",
  },
  updatedAt: "2026-01-15T00:00:00.000Z",
  steps: [
    {
      key: stepKey("aaaa", "/login"),
      textKey: "aaaa",
      route: "/login",
      text: 'Fill "Email" with {{params.email}}',
      kind: "action",
      commands: [
        {
          action: {
            type: "fill",
            target: { kind: "label", text: "Email", exact: true },
            value: "{{params.email}}",
          },
          fingerprint: {
            primary: { kind: "label", text: "Email", exact: true },
            fallbacks: [{ kind: "css", selector: "#login-email" }],
            role: "textbox",
            name: "Email",
            tag: "input",
            attributes: { id: "login-email", type: "email" },
            anchorText: "Log in",
            framePath: [],
            box: { x: 1, y: 2, width: 3, height: 4 },
          },
          expectPost: { appeared: [{ role: "textbox", name: "Email", text: "{{params.email}}" }] },
          wait: { settledMs: 310, waitedFor: { network: 0, dom: 300, busy: 0 } },
        },
      ],
      reasoning: "the email is filled in",
      source: "ai",
      recordedAt: "2026-01-15T00:00:00.000Z",
    },
  ],
  checks: [
    {
      key: checkKey("bbbb"),
      textKey: "bbbb",
      text: 'the page heading is "Dashboard"',
      soft: false,
      check: { type: "pending" },
      generatedBy: "ai",
      recordedAt: "2026-01-15T00:00:00.000Z",
    },
  ],
};

describe("recording format", () => {
  it("round-trips and serializes stably, with keys in schema order", () => {
    const text = serializeRecording(recording);
    const parsed = parseRecording(text);
    expect(parsed).toEqual({ ok: true, recording });
    // Key order of the input doesn't matter: the output is always the same bytes.
    const shuffled = JSON.parse(text);
    const reordered = { checks: shuffled.checks, steps: shuffled.steps, ...shuffled };
    expect(serializeRecording(reordered)).toBe(text);
    expect(text.split("\n").slice(0, 4)).toEqual([
      "{",
      '  "recordingVersion": 1,',
      '  "testId": "tests__login",',
      '  "testPath": "tests/login.test.md",',
    ]);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("rejects refs, results and unknown actions", () => {
    const withRef = JSON.parse(serializeRecording(recording));
    withRef.steps[0].commands[0].action.target = { ref: "e12" };
    expect(parseRecording(JSON.stringify(withRef)).ok).toBe(false);
    const evaluate = JSON.parse(serializeRecording(recording));
    evaluate.steps[0].commands[0].action = { type: "evaluate", script: "1" };
    expect(parseRecording(JSON.stringify(evaluate)).ok).toBe(false);
    const passed = JSON.parse(serializeRecording(recording));
    passed.steps[0].passed = true;
    expect(
      serializeRecording(parseRecording(JSON.stringify(passed)).ok ? passed : recording),
    ).not.toContain("passed");
    expect(parseRecording("not json")).toMatchObject({ ok: false });
  });

  it("defines every check op now, for LOOP-2", () => {
    const ops = [
      {
        type: "text",
        target: { kind: "role", role: "heading" },
        match: "equals",
        value: "Dashboard",
      },
      { type: "url", match: "contains", value: "/dashboard" },
      {
        type: "element_state",
        target: { kind: "text", text: "Saved" },
        state: "visible",
        scope: { kind: "role", role: "dialog", frame: [{ kind: "title", text: "Pay" }] },
      },
      { type: "count", target: { kind: "role", role: "row" }, n: 6 },
      { type: "network", method: "POST", url: "/api/projects", status: 201 },
      {
        type: "aria_snapshot",
        target: { kind: "role", role: "list" },
        snapshot: "- listitem: Q3 roadmap",
      },
      { type: "code", code: "await expect(page).toHaveTitle(/Shop/);" },
      { type: "pending" },
    ];
    for (const check of ops) {
      const next = { ...recording, checks: [{ ...recording.checks[0], check }] } as Recording;
      expect(parseRecording(serializeRecording(next)), check.type).toMatchObject({ ok: true });
    }
  });
});

describe("keys and routes (REP-7)", () => {
  it("normalizes routes: path only, ids replaced", () => {
    expect(routeOf("http://127.0.0.1:4100/checkout?plan=pro#x")).toBe("/checkout");
    expect(routeOf("https://shop.test/orders/1042/items/")).toBe("/orders/:id/items");
    expect(routeOf("/projects/3f2a9c1e-8b7d-4c2a-9e1f-0a1b2c3d4e5f/edit")).toBe(
      "/projects/:id/edit",
    );
    expect(routeOf("/runs/01J9ZQ4Y6T3H8K2M5N7P9R1S3V")).toBe("/runs/:id");
    expect(routeOf("http://x.test")).toBe("/");
    expect(routeOf("about:blank")).toBe("about:blank");
  });

  it("builds step keys from textKey, route and epoch only", () => {
    const key = stepKey("0123456789abcdef", "/login");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(stepKey("0123456789abcdef", "/login")).toBe(key);
    expect(stepKey("0123456789abcdef", "/signup")).not.toBe(key);
    expect(stepKey("0123456789abcdef", "/login", RECORDING_EPOCH + 1)).not.toBe(key);
    expect(checkKey("0123456789abcdef")).not.toBe(key);
  });
});

describe("templates", () => {
  const variables = [
    { ref: "data.email", value: "ada@example.com" },
    { ref: "params.name", value: "Ada King" },
    { ref: "secret.SHOP_PASSWORD" },
    { ref: "env.PLAN" },
  ];

  it("turns typed values into references and escapes stray braces", () => {
    expect(toTemplate("ada@example.com", variables)).toBe("{{data.email}}");
    expect(toTemplate("Hi Ada King!", variables)).toBe("Hi {{params.name}}!");
    expect(toTemplate("{{ secret.SHOP_PASSWORD }}", variables)).toBe("{{secret.SHOP_PASSWORD}}");
    expect(toTemplate("{{data.other}}", variables)).toBe("\\{{data.other}}");
    expect(toTemplate("Q3 roadmap", variables)).toBe("Q3 roadmap");
  });

  it("splits templates for the driver: text, secrets by name, unresolved refs", () => {
    const values = { "data.email": "ada@example.com" };
    expect(templateParts("{{data.email}}", values)).toEqual([{ text: "ada@example.com" }]);
    expect(templateParts("{{secret.SHOP_PASSWORD}}", values)).toEqual([
      { secret: "SHOP_PASSWORD" },
    ]);
    expect(templateParts("x {{env.PLAN}}", values)).toEqual([
      { text: "x " },
      { unresolved: "env.PLAN" },
    ]);
    expect(templateParts("\\{{data.email}}", values)).toEqual([{ text: "{{data.email}}" }]);
    expect(templateRefs("{{data.email}} and {{secret.X}}")).toEqual(["data.email", "secret.X"]);
  });
});
