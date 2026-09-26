import { createSecretValue } from "@testament/config/node";
import { serializeRecording } from "@testament/recording";
import { expandTest, mapReader, parseTest } from "@testament/spec";
import { describe, expect, it } from "vitest";
import { authorTest } from "./author.js";
import { checkGuards, destructiveIntent, parseGuard } from "./guards.js";
import {
  agentScript,
  element,
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
    expect(report.steps.map((s) => s.status)).toEqual([
      "recorded",
      "recorded",
      "recorded",
      "pending",
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
    expect(recording.checks.map((c) => [c.text, c.soft, c.check.type])).toEqual([
      ['the heading is "Dashboard"', false, "pending"],
      ["it looks fine", true, "pending"],
    ]);
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
    expect(report.totals.aiCalls).toBe(6);
    expect(report.totals.costUsd).toBeGreaterThan(0);
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
      ["pending", null],
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

  it("gives the model exactly the harness actions plus three control tools", () => {
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
