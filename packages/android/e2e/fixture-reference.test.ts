import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSecretValue } from "@testament/config/node";
import {
  ALLOWED_DOMAINS,
  APP_PACKAGE,
  apkPath,
  FIXTURE_DIR,
  SHOP_PORT,
  VARIANTS,
  type Variant,
} from "@testament/fixture-android";
import { type RunningShop, startShop } from "@testament/fixture-shop";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  type AndroidAction,
  type AndroidActionOutcome,
  type AndroidSession,
  type LaunchedEmulator,
  launchEmulator,
  openAndroidSession,
} from "../src/index.js";

// The fixture's reference suite (BEN-1): every .test.md × variant, driven through
// the harness by hand-written steps, must reach exactly the verdict and failing
// step in bench/fixtures/android/manifest.yaml. A step fails when its action
// doesn't succeed, when a tap has no visible effect (VER-5), or when its check
// fails. Steps accept the labels of the cosmetic build too, as a person would.

type Answer = "passed" | { verdict: string; step: number; cause: string; reason: string };
const manifest = parse(readFileSync(join(FIXTURE_DIR, "manifest.yaml"), "utf8")) as {
  tests: Record<string, Record<Variant, Answer>>;
};

interface Run {
  session: AndroidSession;
  last: AndroidActionOutcome | null;
}
type Step = (run: Run) => Promise<boolean>;

const TAPS = new Set(["tap", "click", "long_press"]);

/** Tries each target in turn (the correct build's label first); a tap must change something. */
function act(make: (name: string) => AndroidAction, names: string[]): Step {
  return async (run) => {
    for (const name of names) {
      const outcome = await run.session.act(make(name));
      if (outcome.status === "not_found") continue;
      run.last = outcome;
      return outcome.status === "ok" && (!TAPS.has(outcome.action.type) || outcome.post.changed);
    }
    return false;
  };
}

const tap = (role: string, ...names: string[]) =>
  act((name) => ({ type: "tap", target: { kind: "role", role, name, exact: false } }), names);
const type = (value: string | { secret: string }, ...fields: string[]) =>
  act((name) => ({ type: "type", target: { kind: "role", role: "textbox", name }, value }), fields);
const scrollTo = (...names: string[]) =>
  act((name) => ({ type: "scroll", target: { kind: "role", role: "button", name } }), names);

const heading =
  (value: string): Step =>
  async (run) =>
    (
      await run.session.check({
        type: "text",
        target: { kind: "role", role: "heading" },
        match: "equals",
        value,
      })
    ).passed;
const says =
  (value: string): Step =>
  async (run) =>
    (
      await run.session.check(
        { type: "text", target: { kind: "text", text: value }, match: "equals", value },
        { timeoutMs: 8_000 },
      )
    ).passed;
const listShows =
  (name: string): Step =>
  async (run) =>
    (
      await run.session.check({
        type: "count",
        target: { kind: "role", role: "listitem", name },
        min: 1,
      })
    ).passed;
const toasted =
  (text: string): Step =>
  async (run) =>
    run.last?.post.toasts.includes(text) ?? false;
const dialogAsks =
  (title: string): Step =>
  async (run) => {
    const first = (await run.session.observe()).elements[0];
    return first?.role === "dialog" && first.name === title;
  };
const allowCamera: Step = async (run) => {
  const outcome = await run.session.act({ type: "permission", decision: "allow" });
  run.last = outcome;
  return outcome.status === "ok";
};
const openLink =
  (url: string): Step =>
  async (run) => {
    const outcome = await run.session.act({ type: "open_deep_link", url });
    run.last = outcome;
    return outcome.status === "ok";
  };

const signInSteps: Step[] = [
  type("ada@example.com", "Email", "Email address"),
  type({ secret: "SHOP_PASSWORD" }, "Password", "Your password"),
  tap("button", "Sign in", "Log in"),
  heading("Projects"),
];
/** `Use: flows/sign-in.test.md` as one step. */
const signIn: Step = async (run) => {
  for (const step of signInSteps) if (!(await step(run))) return false;
  return true;
};

const SCRIPTS: Record<string, Step[]> = {
  "sign-in": [...signInSteps, listShows("Website redesign")],
  "wrong-password": [
    type("ada@example.com", "Email", "Email address"),
    type("not-the-password", "Password", "Your password"),
    tap("button", "Sign in", "Log in"),
    says("Email or password is incorrect."),
    heading("Sign in to Acme Shop"),
  ],
  "create-project": [
    signIn,
    tap("button", "New project", "Add project"),
    type("Q3 roadmap", "Project name", "Name"),
    tap("button", "Create project", "Create"),
    toasted("Project created"),
    listShows("Q3 roadmap"),
    tap("button", "Refresh", "Reload"),
    listShows("Q3 roadmap"),
  ],
  "sign-out": [
    signIn,
    tap("button", "Sign out", "Log out"),
    dialogAsks("Sign out of Acme Shop?"),
    tap("button", "sign out", "log out"),
    heading("Sign in to Acme Shop"),
  ],
  "scan-badge": [
    signIn,
    tap("listitem", "Website redesign"),
    heading("Website redesign"),
    tap("button", "Scan badge", "Scan a badge"),
    allowCamera,
    says("Camera access allowed"),
  ],
  "deep-link": [signIn, openLink("acmeshop://projects/Mobile%20launch"), heading("Mobile launch")],
  "check-updates": [
    signIn,
    tap("button", "Settings", "Preferences"),
    scrollTo("Check for updates", "Look for updates"),
    tap("button", "Check for updates", "Look for updates"),
    says("Couldn't check for updates."),
  ],
};

/** A test file's numbered steps and its setup seed. */
function testFile(name: string): { steps: number; seed: unknown } {
  const text = readFileSync(join(FIXTURE_DIR, "tests", `${name}.test.md`), "utf8");
  const front = parse(text.split(/^---$/m)[1] ?? "") as {
    setup?: { request: string; body?: unknown }[];
  };
  const steps = text.split("\n").filter((line) => /^\d+\. /.test(line)).length;
  return {
    steps,
    seed: front.setup?.find((hook) => hook.request === "POST /__test/seed")?.body ?? {},
  };
}

let shop: RunningShop;
let emulator: LaunchedEmulator;
const secret = createSecretValue("SHOP_PASSWORD", "shop-demo-pass", { domains: [APP_PACKAGE] });

beforeAll(async () => {
  shop = await startShop({ port: SHOP_PORT });
  emulator = await launchEmulator({ onProgress: (message) => console.log(message) });
});

afterAll(async () => {
  await emulator?.close();
  await shop?.stop();
});

describe("reference suite: the fixture behaves as its manifest says", () => {
  it("scripts every test, one step per numbered step", () => {
    const tests = readdirSync(join(FIXTURE_DIR, "tests"))
      .filter((f) => f.endsWith(".test.md"))
      .map((f) => f.replace(/\.test\.md$/, ""))
      .sort();
    expect(Object.keys(SCRIPTS).sort()).toEqual(tests);
    for (const [name, steps] of Object.entries(SCRIPTS))
      expect(steps.length, name).toBe(testFile(name).steps);
  });

  for (const variant of VARIANTS) {
    for (const [name, steps] of Object.entries(SCRIPTS)) {
      it(`${name} × ${variant}`, async () => {
        await fetch(`${shop.url}/__test/reset?environment=1`, { method: "POST" });
        await fetch(`${shop.url}/__test/seed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(testFile(name).seed),
        });
        const opened = await openAndroidSession({
          apk: apkPath(variant),
          emulator,
          allowedDomains: [...ALLOWED_DOMAINS],
          secrets: { SHOP_PASSWORD: secret },
        });
        if (!opened.ok) throw new Error(`${opened.reason}: ${opened.message}`);
        const run: Run = { session: opened.session, last: null };
        let failedAt: number | null = null;
        try {
          for (const [index, step] of steps.entries()) {
            if (!(await step(run))) {
              failedAt = index + 1;
              break;
            }
          }
        } finally {
          await opened.session.close();
        }
        const expected = manifest.tests[name]?.[variant];
        const got = failedAt === null ? "passed" : { verdict: "failed", step: failedAt };
        expect(got).toEqual(
          expected === "passed" ? "passed" : { verdict: expected?.verdict, step: expected?.step },
        );
      });
    }
  }
});
