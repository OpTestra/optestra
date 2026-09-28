import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type LaunchedEmulator, launchEmulator } from "@testament/android";
import { brand } from "@testament/brand";
import { ENV_PREFIX } from "@testament/config";
import type { TestResult } from "@testament/contract";
import { apkPath, apksBuilt, FIXTURE_DIR, SHOP_PORT } from "@testament/fixture-android";
import { type RunningShop, startShop } from "@testament/fixture-shop";
import type { Recording } from "@testament/recording";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentScript,
  type PlannedCall,
  scriptedModels,
} from "../src/author/test-kit.test-support.js";
import { runTests, type RunTestsOptions } from "../src/run/runner.js";

// The engine on the Android fixture (MOB-1): the target layer opens emulator
// sessions, a scripted model authors every fixture test with the Android tools,
// checks compile by rules on app screens, and the recordings replay with no AI.
// The emulator, the app, the harness and its guards are real; only the model's
// replies are pre-written. Needs the APKs and an Android SDK.

const PASSWORD = "shop-demo-pass";
const CLI = fileURLToPath(new URL("../../cli/bin/cli.js", import.meta.url));

/** Every ref of `role "name"` in the screen of a prompt (case-insensitive name). */
function refsIn(text: string, roles: string[], name: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(/- (\w+) "((?:[^"\\]|\\.)*)" \[(e\d+)\]/g)) {
    const [, role, n, ref] = match;
    if (roles.includes(role ?? "") && n?.toLowerCase() === name.toLowerCase())
      refs.push(ref as string);
  }
  return refs;
}

const tap =
  (name: string, roles = ["button"], pick: "first" | "last" = "first") =>
  (text: string, turn: number): PlannedCall[] | "done" => {
    if (turn > 0) return "done";
    const refs = refsIn(text, roles, name);
    const ref = pick === "first" ? refs[0] : refs.at(-1);
    if (!ref) throw new Error(`no ${roles.join("/")} "${name}" on the screen:\n${text}`);
    return [{ name: "tap", input: { ref } }];
  };
const type = (field: string, value: string) => (text: string, turn: number) =>
  turn > 0
    ? ("done" as const)
    : [{ name: "type", input: { ref: refsIn(text, ["textbox"], field)[0], value } }];

/** The model's plan per step line: what a person would do on the correct build. */
const PLANS: Parameters<typeof agentScript>[0] = [
  [/^Type not-the-password into "Password"/, type("Password", "not-the-password")],
  [/into "Email"/, type("Email", "ada@example.com")],
  [/into "Password"/, type("Password", "{{secret.SHOP_PASSWORD}}")],
  [/^Type Q3 roadmap into "Project name"/, type("Project name", "Q3 roadmap")],
  [/^Tap "Sign out" in the dialog/, tap("Sign out", ["button"], "last")],
  [/^Tap "Website redesign"/, tap("Website redesign", ["listitem", "button"])],
  [
    /^Tap "([^"]+)"/,
    (text, turn) => tap(/^Tap "([^"]+)"/.exec(stepOf(text))?.[1] ?? "")(text, turn),
  ],
  [
    /^Scroll down to "Check for updates"/,
    (text, turn) => {
      // Scroll to it once it's in the screen's tree, else page down (at most three times).
      const ref = refsIn(text, ["button"], "Check for updates")[0];
      if (turn === 0 && ref) return [{ name: "scroll", input: { ref } }];
      if (turn < 3 && !ref) return [{ name: "scroll", input: { direction: "down" } }];
      return "done";
    },
  ],
  [/^Allow camera access/, [{ name: "permission", input: { decision: "allow" } }]],
  [
    /^Open the link/,
    [{ name: "open_link", input: { url: "acmeshop://projects/Mobile%20launch" } }],
  ],
];
const stepOf = (text: string) => /Current step [^:]*: (.*)/.exec(text)?.[1] ?? "";

/** A private copy of the fixture project, without its committed recordings. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "e2e-android-"));
  cpSync(join(FIXTURE_DIR, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(FIXTURE_DIR, "tests"), join(dir, "tests"), {
    recursive: true,
    filter: (source) => !source.includes(brand.dataDirName),
  });
  return dir;
}

let shop: RunningShop;
let emulator: LaunchedEmulator | undefined;
let dir: string;
const env = (variant: Parameters<typeof apkPath>[0] = "correct") => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  ...(process.env.ANDROID_HOME ? { ANDROID_HOME: process.env.ANDROID_HOME } : {}),
  [`${ENV_PREFIX}APP`]: apkPath(variant),
  SHOP_PASSWORD: PASSWORD,
});
const reset: RunTestsOptions["beforeAttempt"] = async ({ attempt, session }) => {
  await session.hookRequest({
    method: "POST",
    target: attempt === 1 ? "/__test/reset?environment=1" : "/__test/reset",
  });
};
const run = (options: Partial<RunTestsOptions>) =>
  runTests({
    projectDir: dir,
    env: env(),
    ...(emulator ? { emulator } : {}),
    retries: 0,
    video: false,
    inbox: null,
    beforeAttempt: reset,
    ...options,
  });
const verdicts = (tests: readonly TestResult[]) =>
  Object.fromEntries(tests.map((t) => [t.file, t.verdict]));
const recordings = () =>
  readdirSync(join(dir, "tests", brand.dataDirName)).filter((f) => f.endsWith(".steps.json"));

beforeAll(async () => {
  if (!apksBuilt())
    throw new Error(
      "Build the fixture APKs first: pnpm --filter @testament/fixture-android build:apks",
    );
  shop = await startShop({ variant: "correct", port: SHOP_PORT });
  emulator = await launchEmulator({ onProgress: (message) => console.log(message) });
  dir = project();
});

afterAll(async () => {
  await emulator?.close();
  await shop?.stop();
  if (dir && !process.env.KEEP_E2E_DIR) rmSync(dir, { recursive: true, force: true });
  else if (dir) console.log(`kept ${dir}`);
});

describe("the engine on Android (scripted model)", () => {
  it("authors every fixture test once, with Android tools and rule-compiled checks", async () => {
    const { models, calls } = scriptedModels(agentScript(PLANS));
    const result = await run({ models, mode: "normal" });
    expect(result.run.blocked).toBeNull();
    expect(verdicts(result.tests)).toEqual({
      "tests/check-updates.test.md": "passed",
      "tests/create-project.test.md": "passed",
      "tests/deep-link.test.md": "passed",
      "tests/scan-badge.test.md": "passed",
      "tests/sign-in.test.md": "passed",
      "tests/sign-out.test.md": "passed",
      "tests/wrong-password.test.md": "passed",
    });
    // The target layer: an Android matrix entry, from the project's android section.
    for (const test of result.tests)
      expect(test.matrix).toEqual({ target: "android", androidVersion: "16", device: "pixel-8" });
    // Only the planner was asked (actions); every check compiled by rules.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => JSON.stringify(c.prompt).includes("SCREEN CONTENT"))).toBe(true);
    // A `Use:` flow's steps are recorded in each test that uses it.
    expect(recordings()).toHaveLength(7);
  });

  it("records Android locators, fingerprints, activity routes and a secret reference only", () => {
    const text = (file: string) =>
      readFileSync(join(dir, "tests", brand.dataDirName, file), "utf8");
    const signIn = JSON.parse(text("tests__sign-in.steps.json")) as Recording;
    expect(signIn.target).toBe("android");
    expect(signIn.recordedWith).toMatchObject({
      browser: "android",
      device: "pixel-8",
      promptVersion: "planner-android-v2",
    });
    const actions = signIn.steps.map((s) => s.commands[0]?.action);
    expect(actions[0]).toMatchObject({ type: "fill", value: "ada@example.com" });
    expect(actions[1]).toMatchObject({ type: "fill", value: "{{secret.SHOP_PASSWORD}}" });
    expect(actions[2]).toMatchObject({
      type: "click",
      target: { kind: "role", role: "button", name: "Sign in" },
    });
    const fingerprint = signIn.steps[2]?.commands[0]?.fingerprint;
    expect(fingerprint?.tag).toBe("android.widget.Button");
    expect(fingerprint?.attributes["resource-id"]).toMatch(/:id\//);
    expect(fingerprint?.fallbacks.map((l) => l.kind)).toEqual(
      expect.arrayContaining(["testId", "css"]),
    );
    // The route (REP-7) is the activity.
    expect(signIn.steps.map((s) => s.route)).toEqual(Array(3).fill("android-app:/.SignInActivity"));
    expect(signIn.steps[2]?.commands[0]?.expectPost.urlChange).toBe(
      "android-app:/.ProjectsActivity",
    );
    expect(signIn.checks.map((c) => [c.check.type, c.generatedBy])).toEqual([
      ["text", "rules"],
      ["text", "rules"],
    ]);
    // The password is never written anywhere in the project.
    for (const file of recordings()) expect(text(file)).not.toContain(PASSWORD);
    const toast = (JSON.parse(text("tests__create-project.steps.json")) as Recording).checks.find(
      (c) => c.text.includes("a message says"),
    );
    expect(toast?.check).toMatchObject({ target: { kind: "role", role: "status" } });
    const dialog = (JSON.parse(text("tests__sign-out.steps.json")) as Recording).checks.find((c) =>
      c.text.includes("a dialog asks"),
    );
    expect(dialog?.check).toMatchObject({ target: { kind: "role", role: "dialog" } });
    const deepLink = JSON.parse(text("tests__deep-link.steps.json")) as Recording;
    expect(deepLink.steps.at(-1)?.commands[0]?.action).toEqual({
      type: "open_deep_link",
      url: "acmeshop://projects/Mobile%20launch",
    });
    const scan = JSON.parse(text("tests__scan-badge.steps.json")) as Recording;
    expect(scan.steps.at(-1)?.commands[0]?.action).toEqual({
      type: "permission",
      decision: "allow",
    });
  });

  it("replays every recording with no AI at all", async () => {
    const result = await run({ models: null, mode: "replay-only" });
    expect(Object.values(verdicts(result.tests))).toEqual(Array(7).fill("passed"));
    expect(result.tests.reduce((sum, t) => sum + t.ai.calls, 0)).toBe(0);
  });

  it("fails the silent-tap trap at the tap, as a product bug", async () => {
    const result = await run({
      env: env("broken-silent-tap"),
      tests: [join(dir, "tests", "create-project.test.md")],
      models: null,
      mode: "replay-only",
    });
    const test = result.tests[0];
    expect(test?.verdict).toBe("failed");
    expect(test?.failureCause).toBe("product_bug");
    const failed = test?.attempts[0]?.steps.find((s) => s.status === "failed");
    expect(failed?.text).toBe('Tap "Create project"');
  });

  it("blocks a test whose app can't be installed, with the reason", async () => {
    const result = await run({
      env: { ...env(), [`${ENV_PREFIX}APP`]: join(dir, "missing.apk") },
      tests: [join(dir, "tests", "sign-in.test.md")],
      models: null,
      mode: "replay-only",
    });
    expect(result.tests[0]?.verdict).toBe("blocked");
    expect(result.tests[0]?.decidedBy).toContainEqual(
      expect.objectContaining({ kind: "blocked", reason: "app_install_failed" }),
    );
  });

  it("blocks what can't run on Android yet (code steps), with the reason", async () => {
    const file = join(dir, "tests", "code-step.test.md");
    writeFileSync(file, "---\nname: Code step\n---\n\n1. ```ts\n   await page.reload();\n   ```\n");
    try {
      const result = await run({ tests: [file], models: null, mode: "replay-only" });
      expect(result.tests[0]?.verdict).toBe("blocked");
      expect(result.tests[0]?.decidedBy).toContainEqual(
        expect.objectContaining({
          kind: "blocked",
          reason: "config_error",
          message: expect.stringContaining("can't run on Android yet"),
        }),
      );
    } finally {
      rmSync(file);
    }
  });

  it("runs a matrix of Android devices, one result per entry, with locale and timezone", async () => {
    // Its own emulators (one per device, one at a time), so the shared one goes first.
    await emulator?.close();
    emulator = undefined;
    const result = await run({
      tests: [join(dir, "tests", "sign-in.test.md")],
      devices: ["pixel-8", "small-phone"],
      locale: "de-DE",
      timezone: "Europe/Berlin",
      models: null,
      mode: "replay-only",
    });
    expect(result.run.blocked).toBeNull();
    expect(result.tests.map((t) => [t.testId, t.verdict, t.matrix])).toEqual([
      [
        "tests__sign-in@android16-pixel-8",
        "passed",
        { target: "android", androidVersion: "16", device: "pixel-8" },
      ],
      [
        "tests__sign-in@android16-small-phone",
        "passed",
        { target: "android", androidVersion: "16", device: "small-phone" },
      ],
    ]);
    expect(result.tests.reduce((sum, t) => sum + t.ai.calls, 0)).toBe(0);
  });

  it("runs the recordings from the CLI with no AI (its own emulator)", async () => {
    const output = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [CLI, "run", "--replay-only", "--no-video", "-C", dir],
        { env: { ...env() }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        out += chunk;
      });
      child.on("close", (code) => resolve({ code, out }));
    });
    expect(output.code, output.out).toBe(0);
  });
});
