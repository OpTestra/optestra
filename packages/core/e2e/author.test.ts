import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser, type LaunchedBrowser, openSession } from "@testament/browser";
import { createSecretValue } from "@testament/config/node";
import { serializeRecording } from "@testament/recording";
import { loadTest } from "@testament/spec/node";
import { startShop, type Variant } from "@testament/fixture-shop";
import { authorTest } from "../src/author/author.js";
import {
  agentScript,
  promptText,
  scriptedModels,
  type PlannedCall,
} from "../src/author/test-kit.test-support.js";

// authorTest on the real shop with a scripted model: the harness, guards and
// VER-5 checks are real; only the model's replies are pre-written.

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const PASSWORD = "shop-demo-pass";
const secrets = {
  SHOP_PASSWORD: createSecretValue("SHOP_PASSWORD", PASSWORD, { domains: ["127.0.0.1"] }),
};
const meta = (testPath: string) => ({
  testPath,
  target: "web" as const,
  engineVersion: "0.1.0",
  device: "desktop",
  environment: "local",
});

const loginPlans: Array<[RegExp, PlannedCall[]]> = [
  [/^Go to \/login/, [{ name: "goto", input: { url: "/login" } }]],
  [
    /^Fill "Email"/,
    [{ name: "fill", on: { role: "textbox", name: "Email" }, input: { value: "ada@example.com" } }],
  ],
  [
    /^Fill "Password"/,
    [
      {
        name: "fill",
        on: { role: "textbox", name: "Password" },
        input: { value: "{{secret.SHOP_PASSWORD}}" },
      },
    ],
  ],
  [/^Click "Log in"/, [{ name: "click", on: { role: "button", name: "Log in" } }]],
];

let browser: LaunchedBrowser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser.close();
});

async function author(
  variant: Variant,
  testPath: string,
  plans: Parameters<typeof agentScript>[0],
  extra: { cap?: number } = {},
) {
  const shop = await startShop({ variant, port: 0 });
  try {
    const loaded = await loadTest(SHOP, testPath, undefined, { seed: "e2e" });
    if (!loaded) throw new Error(`no ${testPath}`);
    const { models, calls } = scriptedModels(agentScript(plans), extra);
    const session = await openSession({
      browser,
      baseUrl: shop.url,
      allowedDomains: ["127.0.0.1"],
      secrets,
      allowUpload: { dir: `${SHOP}tests` },
      evidence: { trace: true, console: true, network: true },
    });
    const result = await authorTest(loaded.expanded, {
      session,
      models,
      timeoutMs: 60_000,
      meta: testPath === "" ? meta("") : meta(testPath),
    });
    const closed = await session.close();
    return { ...result, calls, closed, shop };
  } finally {
    await shop.stop();
  }
}

describe("authorTest on the shop (scripted model)", () => {
  it("authors the login test with role/label locators, templates and pending checks", async () => {
    const { recording, report, calls, closed } = await author("correct", "tests/login.test.md", [
      ...loginPlans,
      [/^Click "Log out"/, [{ name: "click", on: { role: "button", name: "Log out" } }]],
    ]);
    expect(report.hooks).toMatchObject([
      { phase: "setup", description: "POST /__test/seed", status: "ok", httpStatus: 201 },
    ]);
    expect(report.outcome).toBe("recorded");
    expect(report.steps.map((s) => s.status)).toEqual([
      "recorded",
      "recorded",
      "recorded",
      "pending",
      "pending",
      "recorded",
      "pending",
    ]);
    const actions = recording.steps.map((s) => s.commands[0]?.action);
    expect(actions).toEqual([
      {
        type: "fill",
        target: { kind: "role", role: "textbox", name: "Email", exact: true },
        value: "ada@example.com",
      },
      {
        type: "fill",
        target: { kind: "role", role: "textbox", name: "Password", exact: true },
        value: "{{secret.SHOP_PASSWORD}}",
      },
      { type: "click", target: { kind: "role", role: "button", name: "Log in", exact: true } },
      { type: "click", target: { kind: "role", role: "button", name: "Log out", exact: true } },
    ]);
    const login = recording.steps[2]?.commands[0];
    expect(login?.expectPost.urlChange).toBe("/dashboard");
    expect(login?.expectPost.requests).toContainEqual({
      method: "POST",
      route: "/login",
      status: 303,
    });
    expect(login?.fingerprint?.fallbacks.map((l) => l.kind)).toContain("css");
    expect(recording.steps.map((s) => s.route)).toEqual([
      "/login",
      "/login",
      "/login",
      "/dashboard",
    ]);
    expect(recording.checks.map((c) => c.check.type)).toEqual(["pending", "pending", "pending"]);
    // The secret is typed but appears nowhere: recording, report, prompts, evidence.
    const leak = [serializeRecording(recording), JSON.stringify(report), ...calls.map(promptText)];
    for (const file of closed.evidence) leak.push(readFileSync(file.path).toString("latin1"));
    expect(leak.join("\n")).not.toContain(PASSWORD);
    expect(calls.map(promptText).join("\n")).toContain("<<<PAGE CONTENT");
  });

  it("fails create-project with no_visible_effect on broken-silent-click, though the model says done", async () => {
    const { report, recording } = await author(
      "broken-silent-click",
      "tests/create-project.test.md",
      [
        ...loginPlans,
        [
          /^Click "Create project"/,
          [{ name: "click", on: { role: "button", name: "Create project" } }],
        ],
      ],
    );
    expect(report.outcome).toBe("failed");
    const step = report.steps.find((s) => s.text === 'Click "Create project"');
    expect(step).toMatchObject({ status: "failed", reason: "no_visible_effect" });
    expect(step?.actions).toMatchObject([{ tool: "click", status: "ok", changed: false }]);
    expect(recording.steps.map((s) => s.text)).toEqual([
      "Go to /login",
      'Fill "Email" with {{params.email}}',
      'Fill "Password" with {{params.password}}',
      'Click "Log in"',
    ]);
    // Inside the flow the typed value is the param, not the address.
    expect(recording.steps[1]?.commands[0]?.action).toMatchObject({ value: "{{params.email}}" });
  });

  it("records create-project on the correct variant", async () => {
    const { report, recording } = await author("correct", "tests/create-project.test.md", [
      ...loginPlans,
      [
        /^Click "Create project"/,
        [{ name: "click", on: { role: "button", name: "Create project" } }],
      ],
      [
        /^Fill "Project name"/,
        [
          {
            name: "fill",
            on: { role: "textbox", name: "Project name" },
            input: { value: "Q3 roadmap" },
          },
        ],
      ],
      [/^Click "Create"$/, [{ name: "click", on: { role: "button", name: "Create" } }]],
      [/^Reload/, [{ name: "reload" }]],
    ]);
    expect(report.outcome).toBe("recorded");
    const create = recording.steps.find((s) => s.text === 'Click "Create"')?.commands[0];
    expect(create?.expectPost.requests).toContainEqual({
      method: "POST",
      route: "/api/projects",
      status: 201,
    });
    expect(create?.wait.settledMs).toBeGreaterThanOrEqual(0);
  });

  it("refuses clicking Delete account under a Never: guard", async () => {
    const { report } = await author("correct", "tests/delete-account-guard.test.md", [
      ...loginPlans,
      [/^Go to the settings page/, [{ name: "goto", input: { url: "/settings" } }]],
      [
        /^Select "Asia\/Tokyo"/,
        (_page, turn) =>
          turn === 0
            ? [{ name: "click", on: { role: "button", name: "Delete account" } }]
            : [{ name: "step_impossible", input: { reason: "blocked by a guard" } }],
      ],
    ]);
    const step = report.steps.find((s) => s.text.startsWith("Select"));
    expect(step).toMatchObject({ status: "failed", reason: "guard_refused" });
    expect(step?.actions).toMatchObject([{ tool: "click", status: "guard_refused" }]);
    expect(step?.refusals[0]).toContain('Never: click "Delete account"');
  });

  it("stops the test on a disallowed-domain navigation", async () => {
    const { report } = await author("correct", "tests/login.test.md", [
      [/^Fill "Email"/, [{ name: "goto", input: { url: "http://localhost:9/steal" } }]],
    ]);
    expect(report).toMatchObject({ outcome: "stopped", stopReason: "disallowed_domain" });
    expect(
      report.steps
        .slice(1)
        .filter((s) => s.kind === "action")
        .every((s) => s.status === "skipped"),
    ).toBe(true);
  });

  it("stops on the budget", async () => {
    const { report } = await author("correct", "tests/login.test.md", loginPlans, { cap: 0.0001 });
    expect(report).toMatchObject({ outcome: "stopped", stopReason: "budget_exceeded" });
  });
});
