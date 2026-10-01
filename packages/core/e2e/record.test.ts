import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import {
  type LaunchedBrowser,
  launchBrowser,
  openSession,
  type ScriptedUser,
} from "@optestra/browser";
import { ENV_PREFIX } from "@optestra/config";
import { createSecretValue } from "@optestra/config/node";
import { type RunningShop, startShop } from "@optestra/fixture-shop";
import { checkTest, mapReader } from "@optestra/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptedModels } from "../src/author/test-kit.test-support.js";
import { saveRecorded } from "../src/record/project.js";
import { type RecordProgress, recordTest } from "../src/record/record.js";
import { runTests } from "../src/run/runner.js";

// Record mode (AUT-8) on the real shop: a scripted user (Playwright driving
// the harness's own page, like a person would) logs in and marks what they
// expect. The result is a lint-clean test with no secret in it, plus a
// recording that replays with ZERO model calls.

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const PASSWORD = "shop-demo-pass";

let browser: LaunchedBrowser;
let shop: RunningShop;
const dirs: string[] = [];
beforeAll(async () => {
  browser = await launchBrowser();
  shop = await startShop({ variant: "correct", port: 0 });
  await fetch(`${shop.url}/__test/seed`, { method: "POST" });
});
afterAll(async () => {
  await shop.stop();
  await browser.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, what: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function record(
  start: string,
  user: (person: ScriptedUser, seen: RecordProgress[]) => Promise<void>,
) {
  const session = await openSession({
    browser,
    baseUrl: shop.url,
    allowedDomains: ["127.0.0.1"],
    secrets: {
      SHOP_PASSWORD: createSecretValue("SHOP_PASSWORD", PASSWORD, { domains: ["127.0.0.1"] }),
    },
    evidence: { trace: false, console: false, network: false, video: false },
  });
  const seen: RecordProgress[] = [];
  let person: ScriptedUser | undefined;
  const stop = new AbortController();
  try {
    const recording = recordTest({
      session,
      start,
      name: "Returning user can log in",
      meta: { engineVersion: "0.1.0", device: "desktop", environment: "local" },
      signal: stop.signal,
      onProgress: (line) => seen.push(line),
      user: (p) => {
        person = p;
      },
    });
    await until(() => person !== undefined, "the page");
    await user(person as ScriptedUser, seen);
    stop.abort();
    return { result: await recording, seen };
  } finally {
    await session.close();
  }
}

describe("record mode on the shop (scripted user)", () => {
  it("records a login: steps, secrets by name, marked expectations; it replays with 0 AI", async () => {
    const { result, seen } = await record("/login", async (person, seen) => {
      const steps = () => seen.filter((s) => s.type === "step").length;
      await person.fill("Email", "ada@example.com");
      await person.fill("Password", PASSWORD);
      await person.click("button", "Log in");
      await until(() => steps() === 3, `three steps: ${JSON.stringify(seen)}`);
      await person.waitForUrl(/\/dashboard/);
      // Alt+Shift+E with nothing selected, then a click: "expect this element".
      await person.press("Alt+Shift+E");
      await person.clickHeading();
      await until(() => seen.some((s) => s.type === "expect"), "the expectation");
    });
    expect(result.ended).toBe("stopped");
    expect(result.text).toBe(`---
name: Returning user can log in
start: /login
data:
  email: ada@example.com
---

1. Fill "Email" with {{data.email}}
2. Fill "Password" with {{secret.SHOP_PASSWORD}}
3. Click "Log in"
4. Expect: the page heading is "Dashboard"
`);
    expect(result.lintClean).toBe(true);
    expect(result.text).not.toContain(PASSWORD);
    expect(JSON.stringify(result.recording)).not.toContain(PASSWORD);
    const lint = await checkTest(result.text, result.path, { readFile: mapReader({}) });
    expect(lint.findings.map((f) => f.rule)).not.toContain("literal-credential");
    expect(seen.filter((s) => s.type === "step").map((s) => (s as { text: string }).text)).toEqual([
      'Fill "Email" with {{data.email}}',
      'Fill "Password" with {{secret.SHOP_PASSWORD}}',
      'Click "Log in"',
    ]);
    // The recording: role locators with fingerprints, the login's effect, a compiled check.
    const [email, password, login] = result.recording.steps;
    expect(email?.source).toBe("record");
    expect(email?.commands[0]?.action).toEqual({
      type: "fill",
      target: { kind: "role", role: "textbox", name: "Email", exact: true },
      value: "{{data.email}}",
    });
    expect(password?.commands[0]?.action).toMatchObject({ value: "{{secret.SHOP_PASSWORD}}" });
    expect(login?.commands[0]?.expectPost.urlChange).toBe("/dashboard");
    expect(login?.commands[0]?.fingerprint?.fallbacks.length).toBeGreaterThan(0);
    expect(result.recording.checks.map((c) => [c.check.type, c.generatedBy])).toEqual([
      ["text", "rules"],
    ]);

    // Saved into a copy of the shop project, it replays with no AI and passes.
    const dir = mkdtempSync(join(tmpdir(), "record-e2e-"));
    dirs.push(dir);
    cpSync(join(SHOP, brand.configFileName), join(dir, brand.configFileName));
    cpSync(join(SHOP, "tests"), join(dir, "tests"), { recursive: true });
    const saved = saveRecorded(
      { ...result, project: dir, environment: "local", absolutePath: join(dir, result.path) },
      join(dir, "tests", "recorded-login.test.md"),
    );
    expect(existsSync(saved.recording)).toBe(true);
    const { models, calls } = scriptedModels(() => ({ text: "the replay must not ask a model" }));
    const run = await runTests({
      projectDir: dir,
      tests: [join(dir, "tests", "recorded-login.test.md")],
      mode: "normal",
      video: false,
      generateSpecs: false,
      models,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        [`${ENV_PREFIX}BASE_URL`]: shop.url,
        SHOP_PASSWORD: PASSWORD,
      },
    });
    expect(run.tests.map((t) => t.verdict)).toEqual(["passed"]);
    expect(calls).toHaveLength(0);
    expect(run.run.cost.aiCalls).toBe(0);
    expect(readFileSync(saved.test, "utf8")).toBe(result.text);
  });

  it("never writes a password it can't name, and a sign-up email becomes {{unique.email}}", async () => {
    const { result } = await record("/signup", async (person, seen) => {
      await person.fill("Email", "someone@example.com");
      await person.fill("Password", "not-a-known-secret-123");
      await person.click("button", /sign up/i);
      await until(() => seen.filter((s) => s.type === "step").length === 3, "three steps");
    });
    expect(result.text).toContain('email: "{{unique.email}}"');
    expect(result.text).toContain('Fill "Password" with {{secret.PASSWORD}}');
    expect(result.text).not.toContain("not-a-known-secret-123");
    expect(JSON.stringify(result.recording)).not.toContain("not-a-known-secret-123");
    expect(result.secrets).toEqual(["PASSWORD"]);
    expect(result.notes.join("\n")).toMatch(/Declare PASSWORD in the project's secrets/);
    expect(result.notes.join("\n")).toMatch(/No expectation was marked/);
  });
});
