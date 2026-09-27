import { createSecretValue } from "@testament/config/node";
import { serializeRecording } from "@testament/recording";
import { expandTest, mapReader, parseTest } from "@testament/spec";
import { describe, expect, it } from "vitest";
import { authorTest } from "./author.js";
import { checkGuards, destructiveIntent, parseGuard } from "./guards.js";
import {
  agentScript,
  element,
  evaluation,
  fakeSession,
  promptText,
  scriptedModels,
} from "./test-kit.test-support.js";
import { PLANNER_TOOLS } from "./tools.js";

const SECRET = "planted-9f3c-secret";
createSecretValue("SHOP_PASSWORD", SECRET, { domains: ["127.0.0.1"] }); // registers it with the default redactor

async function expanded(
  body: string,
  frontmatter = "name: T\nstart: /login",
  files: Record<string, string> = {},
) {
  const text = `---\n${frontmatter}\n---\n\n${body}\n`;
  const { spec } = parseTest(text, "tests/t.test.md");
  return expandTest(spec, {
    readFile: mapReader({ "tests/t.test.md": text, ...files }),
    seed: "s",
  });
}

const meta = {
  testPath: "tests/t.test.md",
  target: "web" as const,
  engineVersion: "0.1.0",
  device: "desktop",
  environment: "local",
};
const loginPage = [
  element("e1", "textbox", "Email"),
  element("e2", "textbox", "Password"),
  element("e3", "button", "Log in"),
  element("e4", "button", "Delete account"),
];

describe("authorTest checks (no browser)", () => {
  it("keeps the line verbatim and a check that fails while authoring, flagged with expected/actual", async () => {
    const line = "The page shows “$0.00  due today”";
    const test = await expanded(`1. Click "Log in"\n2. Expect: ${line}`);
    const session = fakeSession(loginPage, undefined, (_op, options) =>
      evaluation(false, {
        expected: "$0.00  due today",
        actual: options?.on ? "(nothing)" : "$29.00 due today",
      }),
    );
    const { recording, report } = await authorTest(test, {
      session,
      models: scriptedModels(
        agentScript([[/Click/, [{ name: "click", on: { role: "button", name: "Log in" } }]]]),
      ).models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
    });
    expect(recording.checks).toHaveLength(1);
    expect(recording.checks[0]).toMatchObject({
      text: line,
      generatedBy: "rules",
      rule: "visible-text",
      check: { type: "text", match: "contains", value: "$0.00  due today" },
      failedAtAuthoring: { expected: "$0.00  due today", actual: "$29.00 due today" },
      sanity: { provesNothing: false },
    });
    // Evaluated once on the page, then on the empty page and the before-state copy.
    expect(
      session.checked.map((c) =>
        typeof c.options?.on === "object" ? "before" : (c.options?.on ?? "page"),
      ),
    ).toEqual(["page", "blank", "before"]);
    expect(report.steps[1]).toMatchObject({
      status: "recorded",
      check: { status: "failed", passed: false, actual: "$29.00 due today" },
    });
    expect(report.steps[1]?.message).toContain("The check failed while authoring");
    expect(report.outcome).toBe("recorded");
    expect(report.checks).toMatchObject({ total: 1, rules: 1, failedAtAuthoring: 1 });
  });

  it("leaves checks after a stop uncompiled and keeps an earlier compiled one", async () => {
    const test = await expanded('1. Click "Log in"\n2. Expect: the page heading is "Dashboard"');
    const session = fakeSession(loginPage, () => ({ post: { changed: false } }));
    const previous = {
      recordingVersion: 1 as const,
      testId: "tests__t",
      testPath: "tests/t.test.md",
      target: "web" as const,
      recordedWith: {
        engineVersion: "0.1.0",
        epoch: 1,
        browser: "chromium",
        device: "desktop",
        environment: "local",
        model: null,
        promptVersion: null,
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      steps: [],
      checks: [
        {
          key: "0123456789abcdef",
          textKey: test.steps[1]?.textKey ?? "",
          text: 'the page heading is "Dashboard"',
          soft: false,
          check: { type: "url" as const, match: "contains" as const, value: "/dashboard" },
          generatedBy: "rules" as const,
          recordedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const { recording, report } = await authorTest(test, {
      session,
      models: scriptedModels(
        agentScript([[/Click/, [{ name: "click", on: { role: "button", name: "Log in" } }]]]),
      ).models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
      previous,
    });
    expect(report.steps[1]).toMatchObject({ status: "skipped" });
    expect(recording.checks[0]?.check).toEqual({
      type: "url",
      match: "contains",
      value: "/dashboard",
    });
  });
});

describe("authorTest (no browser)", () => {
  it("records commands with locators and templates, never values or secrets", async () => {
    const test = await expanded(
      `1. Use: flows/login.test.md\n2. Expect: the heading is "Dashboard"\n3. Soft: it looks fine`,
      "name: T\nstart: /login\ndata:\n  email: ada@example.com",
      {
        "tests/flows/login.test.md": `---\nname: Log in\nkind: flow\nparams:\n  email: ada@example.com\n  password: "{{secret.SHOP_PASSWORD}}"\n---\n\n1. Fill "Email" with {{params.email}}\n2. Fill "Password" with {{params.password}}\n3. Click "Log in"\n`,
      },
    );
    const { models, calls } = scriptedModels(
      agentScript([
        [
          /Fill "Email"/,
          [
            {
              name: "fill",
              on: { role: "textbox", name: "Email" },
              input: { value: "ada@example.com" },
            },
          ],
        ],
        [
          /Fill "Password"/,
          [
            {
              name: "fill",
              on: { role: "textbox", name: "Password" },
              input: { value: "{{secret.SHOP_PASSWORD}}" },
            },
          ],
        ],
        [/Click "Log in"/, [{ name: "click", on: { role: "button", name: "Log in" } }]],
      ]),
    );
    const session = fakeSession(loginPage);
    const { recording, report } = await authorTest(test, {
      session,
      models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
    });

    expect(report.outcome).toBe("recorded");
    // The Expect line compiles by rules; the Soft one has no rule and the model gives no check.
    expect(report.steps.map((s) => s.status)).toEqual([
      "recorded",
      "recorded",
      "recorded",
      "recorded",
      "pending",
    ]);
    expect(recording.steps.map((s) => s.commands.map((c) => c.action))).toEqual([
      [
        {
          type: "fill",
          target: { kind: "role", role: "textbox", name: "Email", exact: true },
          value: "{{params.email}}",
        },
      ],
      [
        {
          type: "fill",
          target: { kind: "role", role: "textbox", name: "Password", exact: true },
          value: "{{secret.SHOP_PASSWORD}}",
        },
      ],
      [{ type: "click", target: { kind: "role", role: "button", name: "Log in", exact: true } }],
    ]);
    // The harness got the secret by name only.
    expect(session.acted[0]).toEqual({ type: "goto", url: "/login" });
    expect(session.acted[2]).toEqual({
      type: "fill",
      target: { ref: "e2" },
      value: { secret: "SHOP_PASSWORD" },
    });
    expect(recording.steps[0]?.commands[0]?.fingerprint?.fallbacks).toEqual([
      { kind: "css", selector: "#e1" },
    ]);
    expect(recording.checks.map((c) => [c.text, c.soft, c.check.type, c.generatedBy])).toEqual([
      ['the heading is "Dashboard"', false, "text", "rules"],
      ["it looks fine", true, "pending", "rules"],
    ]);
    expect(recording.checks[0]).toMatchObject({
      check: { target: { kind: "role", role: "heading" }, match: "equals", value: "Dashboard" },
      summary: "Checked that a heading is exactly 'Dashboard'",
      rule: "heading",
      sanity: { empty: { result: "failed" }, before: { result: "failed" }, provesNothing: false },
    });
    expect(recording.checks[1]?.problem).toContain("No phrase rule matches this line.");
    expect(recording.steps.every((s) => /^[0-9a-f]{16}$/.test(s.key) && s.route === "/login")).toBe(
      true,
    );
    // Planted secret: nowhere in the recording, the report or any prompt.
    const everything = [
      serializeRecording(recording),
      JSON.stringify(report),
      ...calls.map(promptText),
    ].join("\n");
    expect(everything).not.toContain(SECRET);
    expect(calls.map(promptText).join("\n")).toContain("{{secret.SHOP_PASSWORD}} = (secret");
    expect(report.totals.aiCalls).toBe(7); // 6 for the actions, 1 to compile the Soft line
    expect(report.totals.costUsd).toBeGreaterThan(0);
  });

  it("templates page text with values bound anywhere in the test, not just this step", async () => {
    const test = await expanded(
      `1. Fill "Email" with {{data.email}}\n2. Click "Log in"`,
      "name: T\nstart: /login\ndata:\n  email: ada.king@example.com",
    );
    const { models } = scriptedModels(
      agentScript([
        [
          /Fill/,
          [
            {
              name: "fill",
              on: { role: "textbox", name: "Email" },
              input: { value: "ada.king@example.com" },
            },
          ],
        ],
        [/Click/, [{ name: "click", on: { role: "button", name: "Log in" } }]],
      ]),
    );
    const session = fakeSession(loginPage, (action) => ({
      post: {
        changed: true,
        removed:
          action.type === "click"
            ? [{ role: "textbox", name: "Email", text: "ada.king@example.com" }]
            : [],
        added: [{ role: "status", name: "", text: "Signed in as ada.king@example.com" }],
      },
    }));
    const { recording } = await authorTest(test, {
      session,
      models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
      openStart: false,
    });
    const text = serializeRecording(recording);
    expect(text).not.toContain("ada.king@example.com");
    expect(recording.steps[1]?.commands[0]?.expectPost.removed).toEqual([
      { role: "textbox", name: "Email", text: "{{data.email}}" },
    ]);
  });

  it("fails a step whose actions changed nothing, even when the model says done (VER-5)", async () => {
    const test = await expanded(`1. Click "Log in"`);
    const { models } = scriptedModels(
      agentScript([[/Click/, [{ name: "click", on: { role: "button", name: "Log in" } }]]]),
    );
    const session = fakeSession(loginPage, () => ({ post: { changed: false } }));
    const { report, recording } = await authorTest(test, {
      session,
      models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
    });
    expect(report.outcome).toBe("failed");
    expect(report.steps[0]).toMatchObject({ status: "failed", reason: "no_visible_effect" });
    expect(recording.steps).toEqual([]);
  });

  it("counts a reordering of the page (a sort) as a visible change", async () => {
    const test = await expanded(`1. Click "Log in"`);
    const { models, calls } = scriptedModels(
      agentScript([[/Click/, [{ name: "click", on: { role: "button", name: "Log in" } }]]]),
    );
    const base = fakeSession(loginPage, () => ({ post: { changed: false } }));
    let observed = 0;
    const reordered = [...loginPage].reverse();
    const session = {
      ...base,
      get url() {
        return base.url;
      },
      observe: async () => {
        const page = await base.observe();
        return ++observed >= 2 ? { ...page, elements: reordered } : page;
      },
    };
    const { report } = await authorTest(test, {
      session,
      models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
      openStart: false,
    });
    expect(report.steps[0]).toMatchObject({ status: "recorded" });
    expect(report.steps[0]?.actions[0]).toMatchObject({ changed: true });
  });

  it("accepts an upload that changes nothing visible, but not a click", async () => {
    const test = await expanded(`1. Upload files/a.png to "Choose an image"`);
    const page = [element("e1", "button", "Choose an image")];
    const { models } = scriptedModels(
      agentScript([
        [
          /Upload/,
          [
            {
              name: "upload",
              on: { role: "button", name: "Choose an image" },
              input: { file: "files/a.png" },
            },
          ],
        ],
      ]),
    );
    const { report, recording } = await authorTest(test, {
      session: fakeSession(page, () => ({ post: { changed: false } })),
      models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
      openStart: false,
    });
    expect(report.steps[0]).toMatchObject({ status: "recorded" });
    expect(recording.steps[0]?.commands[0]?.action).toMatchObject({
      type: "upload",
      files: ["files/a.png"],
    });
  });

  it("refuses a Never: guard before acting and says why", async () => {
    const test = await expanded(`1. Click "Delete account"\n\nNever: click "Delete account"`);
    const { models, calls } = scriptedModels(
      agentScript([
        [
          /Delete/,
          (_page, turn) =>
            turn === 0
              ? [{ name: "click", on: { role: "button", name: "Delete account" } }]
              : [{ name: "step_impossible", input: { reason: "guarded" } }],
        ],
      ]),
    );
    const session = fakeSession(loginPage);
    const { report } = await authorTest(test, {
      session,
      models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
      openStart: false,
    });
    expect(session.acted).toEqual([]);
    expect(report.steps[0]).toMatchObject({ status: "failed", reason: "guard_refused" });
    expect(report.steps[0]?.actions[0]).toMatchObject({ status: "guard_refused" });
    expect(promptText(calls[1] ?? calls[0]!)).toContain(
      'Refused: the test says "Never: click "Delete account""',
    );
  });

  it("stops at the action and model-call limits", async () => {
    const test = await expanded(`1. Click "Log in"`);
    const { models } = scriptedModels(
      agentScript([[/Click/, () => [{ name: "hover", on: { role: "button", name: "Log in" } }]]]),
    );
    const session = fakeSession(loginPage);
    const { report } = await authorTest(test, {
      session,
      models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
      openStart: false,
      limits: { actionsPerStep: 3 },
    });
    expect(report.steps[0]).toMatchObject({ status: "failed", reason: "limit_reached" });
    expect(session.acted).toHaveLength(3);

    const chatty = scriptedModels(() => ({ text: "I think I should click it." }));
    const again = await authorTest(test, {
      session: fakeSession(loginPage),
      models: chatty.models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
    });
    expect(again.report.steps[0]).toMatchObject({ status: "failed", reason: "limit_reached" });
    expect(chatty.calls).toHaveLength(3);
  });

  it("stops on the budget (budget_exceeded) without partial success", async () => {
    const test = await expanded(`1. Click "Log in"\n2. Click "Log in"`);
    const { models } = scriptedModels(
      agentScript([[/Click/, [{ name: "click", on: { role: "button", name: "Log in" } }]]]),
      { cap: 0.0001 },
    );
    const { report } = await authorTest(test, {
      session: fakeSession(loginPage),
      models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
    });
    expect(report.outcome).toBe("stopped");
    expect(report.stopReason).toBe("budget_exceeded");
    expect(report.steps.map((s) => s.status)).toEqual(["stopped", "skipped"]);
  });

  it("runs exact ops without a model and stops at code steps", async () => {
    const test = await expanded(
      '1. Exact: click role=button[name="Log in"]\n2. Exact: expect url contains /dashboard\n3. Pick a date\n   ```ts\n   await page.keyboard.press("Escape");\n   ```\n4. Click "Log in"',
    );
    const { models, calls } = scriptedModels(() => ({ text: "unused" }));
    const session = fakeSession(loginPage);
    const { report, recording } = await authorTest(test, {
      session,
      models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
    });
    expect(calls).toHaveLength(0);
    expect(session.acted[1]).toEqual({
      type: "click",
      target: { kind: "role", role: "button", name: "Log in", exact: true },
    });
    expect(report.steps.map((s) => [s.status, s.reason ?? null])).toEqual([
      ["recorded", null],
      ["recorded", null],
      ["stopped", "code_step_needs_replay"],
      ["skipped", null],
    ]);
    expect(recording.steps[0]).toMatchObject({ source: "exact", kind: "exact" });
    expect(recording.checks[0]).toMatchObject({
      generatedBy: "exact",
      check: { type: "url", match: "contains", value: "/dashboard" },
    });
  });

  it("stops on unsupported hooks before touching the page", async () => {
    const test = await expanded(
      `1. Click "Log in"`,
      "name: T\nstart: /login\nsetup:\n  - run: scripts/seed.sh",
    );
    const { models } = scriptedModels(() => ({ text: "unused" }));
    const session = fakeSession(loginPage);
    const { report } = await authorTest(test, {
      session,
      models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
    });
    expect(report).toMatchObject({ outcome: "stopped", stopReason: "hook_unsupported" });
    expect(session.acted).toEqual([]);
  });

  it("keeps a previous step recording when a later run doesn't reach it", async () => {
    const test = await expanded(`1. Click "Log in"\n2. Fill "Email" with x`);
    const first = await authorTest(test, {
      session: fakeSession(loginPage),
      models: scriptedModels(
        agentScript([
          [/Click/, [{ name: "click", on: { role: "button", name: "Log in" } }]],
          [
            /Fill/,
            [{ name: "fill", on: { role: "textbox", name: "Email" }, input: { value: "x" } }],
          ],
        ]),
      ).models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
    });
    expect(first.recording.steps).toHaveLength(2);
    const second = await authorTest(test, {
      session: fakeSession(loginPage),
      models: scriptedModels(
        agentScript([[/Click/, [{ name: "step_impossible", input: { reason: "nope" } }]]]),
      ).models,
      timeoutMs: 30_000,
      meta,
      screenshots: false,
      previous: first.recording,
    });
    expect(second.report.outcome).toBe("failed");
    expect(second.recording.steps).toEqual(first.recording.steps);
  });

  it("gives the model exactly the harness actions, read_inbox and three control tools", () => {
    expect(PLANNER_TOOLS.map((t) => t.name)).toEqual([
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
      "read_inbox",
      "look",
      "step_done",
      "step_impossible",
    ]);
  });
});

describe("guards", () => {
  const target = (name: string, role = "button") => ({ type: "click", target: { role, name } });
  const context = (lines: string[], production = false, allowDestructive: string[] = []) => ({
    guards: lines.map(parseGuard),
    production,
    allowDestructive,
  });

  it("matches Never: lines on quoted text, case- and space-insensitively", () => {
    const never = context(['click "Delete account"', 'click "Yes, delete my account"']);
    expect(checkGuards(target("delete   ACCOUNT"), never).allowed).toBe(false);
    expect(checkGuards(target("Yes, delete my account"), never).allowed).toBe(false);
    expect(checkGuards(target("Delete account permanently"), never).allowed).toBe(false);
    expect(checkGuards(target("Save changes"), never).allowed).toBe(true);
    expect(
      checkGuards({ type: "fill", target: { role: "textbox", name: "Delete account" } }, never)
        .allowed,
    ).toBe(true);
  });

  it("matches descriptions without quotes and goto guards on the URL", () => {
    expect(checkGuards(target("Log out"), context(["click the Log out button"])).allowed).toBe(
      false,
    );
    expect(
      checkGuards({ type: "goto", url: "/admin/users" }, context(['go to "/admin"'])).allowed,
    ).toBe(false);
  });

  it("refuses destructive intents only in production, unless allowed", () => {
    expect(destructiveIntent(target("Delete project"))).toBe("delete");
    expect(destructiveIntent(target("Start trial"))).toBe("pay");
    expect(destructiveIntent(target("Invite teammate"))).toBe("invite");
    expect(destructiveIntent(target("Cancel"))).toBeUndefined();
    expect(destructiveIntent(target("Cancel subscription"))).toBe("cancel");
    expect(checkGuards(target("Delete project"), context([])).allowed).toBe(true);
    const refused = checkGuards(target("Delete project"), context([], true));
    expect(refused).toMatchObject({ allowed: false, kind: "destructive", intent: "delete" });
    expect(checkGuards(target("Delete project"), context([], true, ["delete"])).allowed).toBe(true);
  });
});
