import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { ulid } from "@testament/contract";
import { createDecisions } from "@testament/decide";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CheckOptions,
  type LaunchedBrowser,
  launchBrowser,
  type Observation,
  openSession,
  type Session,
} from "@testament/browser";
import { createSecretValue, loadProject } from "@testament/config/node";
import type { ScriptedCall, ScriptedReply } from "@testament/models/testing";
import { type CheckOp, type Recording, serializeRecording } from "@testament/recording";
import { expandTest, type ExpandedTest, mapReader, parseTest } from "@testament/spec";
import { loadTest } from "@testament/spec/node";
import { startShop, type Variant, verificationCode } from "@testament/fixture-shop";
import { authorTest } from "../src/author/author.js";
import { authoringLogin } from "../src/run/author-login.js";
import type { AuthoringReport } from "../src/author/types.js";
import {
  agentScript,
  type PlannedCall,
  promptText,
  scriptedModels,
} from "../src/author/test-kit.test-support.js";

// LOOP-2 on the real shop: every Expect line compiles by rules (no model),
// passes its sanity test and evaluates to passed on `correct`; broken builds
// fail the right checks with the right expected/actual; a weak check is caught.
// The agent's actions are scripted; checks are never scripted.
// UPDATE_CHECK_FIXTURES=1 rewrites fixtures/checks/shop-correct.json (the saved
// observations and probes the rule unit tests compile against).

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/checks/", import.meta.url));
const PASSWORD = "shop-demo-pass";
const secrets = {
  SHOP_PASSWORD: createSecretValue("SHOP_PASSWORD", PASSWORD, { domains: ["127.0.0.1"] }),
};

// ── The scripted agent (actions only) ────────────────────────────────────────

const refsIn = (text: string, role: string, name: string): string[] =>
  [...text.matchAll(/- (\w+) "((?:[^"\\]|\\.)*)" \[(e\d+)\]/g)]
    .filter(([, r, n]) => r === role && n === name)
    .map((m) => m[3] as string);
const ref = (text: string, role: string, name: string, nth = 0): string => {
  const found = refsIn(text, role, name)[nth];
  if (!found) throw new Error(`no ${role} "${name}" #${nth} in the page`);
  return found;
};
const refOfText = (text: string, shown: string): string => {
  const line = text.split("\n").find((l) => l.includes(`"${shown}"`) && /\[e\d+\]/.test(l));
  const found = line && /\[(e\d+)\]/.exec(line)?.[1];
  if (!found) throw new Error(`no element showing "${shown}"`);
  return found;
};
const emailIn = (text: string) => /\{\{data\.email\}\} = "([^"]+)"/.exec(text)?.[1] ?? "";

type Plan = PlannedCall[] | ((page: string, turn: number) => PlannedCall[] | "done");
const once =
  (make: (page: string) => PlannedCall[]): Plan =>
  (page, turn) => {
    if (turn > 0) return "done";
    try {
      return make(page);
    } catch (error) {
      return [{ name: "step_impossible", input: { reason: String(error) } }];
    }
  };
const click = (role: string, name: string, nth = 0) =>
  once((page) => [{ name: "click", input: { ref: ref(page, role, name, nth) } }]);
const fill = (name: string, value: string): PlannedCall => ({
  name: "fill",
  on: { role: "textbox", name },
  input: { value },
});
const card = (number: string) =>
  once((page) =>
    [
      ["Card number", number],
      ["Expiry date", "12/34"],
      ["CVC", "123"],
    ].map(([name, value]) => ({
      name: "fill",
      input: { ref: ref(page, "textbox", name as string), value },
    })),
  );
const code = (andClick: boolean) =>
  once((page) => [
    {
      name: "fill",
      input: {
        ref: ref(page, "textbox", "Verification code"),
        value: verificationCode(emailIn(page)),
      },
    },
    ...(andClick ? [{ name: "click", input: { ref: ref(page, "button", "Verify") } }] : []),
  ]);

const PLANS: Array<[RegExp, Plan]> = [
  [/^Go to \/login/, [{ name: "goto", input: { url: "/login" } }]],
  [/^Go to \/pricing/, [{ name: "goto", input: { url: "/pricing" } }]],
  [/^Go to the settings page/, [{ name: "goto", input: { url: "/settings" } }]],
  [/^Go to the billing page/, [{ name: "goto", input: { url: "/billing" } }]],
  [/^Go to the orders page/, [{ name: "goto", input: { url: "/orders" } }]],
  [/^Fill "Email" with not-an-email/, [fill("Email", "not-an-email")]],
  [/^Fill "Password" with short/, [fill("Password", "short")]],
  [
    /^Fill "Email"/,
    once((page) => [
      {
        name: "fill",
        input: { ref: ref(page, "textbox", "Email"), value: emailIn(page) || "ada@example.com" },
      },
    ]),
  ],
  [/^Fill "Password"/, [fill("Password", "{{secret.SHOP_PASSWORD}}")]],
  [/^Fill "Full name"/, [fill("Full name", "Ada King")]],
  [/^Fill "Project name"/, [fill("Project name", "Q3 roadmap")]],
  [/^Click "Log in"/, click("button", "Log in")],
  [/^Click "Log out"/, click("button", "Log out")],
  [/^Click "Sign up"/, click("button", "Sign up")],
  [/^Click "Verify"/, click("button", "Verify")],
  [/^Click "Create project"/, click("button", "Create project")],
  [/^Click "Create"$/, click("button", "Create")],
  [/^Click "Save changes"/, click("button", "Save changes")],
  [/^Click "Upload avatar"/, click("button", "Upload avatar")],
  [/^Click "Start trial"/, click("button", "Start trial")],
  [/^Click "Start free trial" on the Pro plan/, click("button", "Start free trial", 1)],
  [/^Click the "Total" column header/, click("button", "Total")],
  [
    /^Click "Show refunded orders"/,
    once((page) => [{ name: "click", input: { ref: refOfText(page, "Show refunded orders") } }]),
  ],
  [/^Reload/, [{ name: "reload" }]],
  [
    /^Upload files\/avatar\.png/,
    once((page) => [
      {
        name: "upload",
        input: { ref: ref(page, "button", "Choose an image"), file: "files/avatar.png" },
      },
    ]),
  ],
  [
    /^Select "Asia\/Tokyo"/,
    once((page) => [
      { name: "select", input: { ref: ref(page, "combobox", "Time zone"), option: "Asia/Tokyo" } },
    ]),
  ],
  [
    /^Select "Europe\/London"/,
    once((page) => [
      {
        name: "select",
        input: { ref: ref(page, "combobox", "Time zone"), option: "Europe/London" },
      },
    ]),
  ],
  [
    /^Sign up with/,
    once((page) => [
      { name: "fill", input: { ref: ref(page, "textbox", "Email"), value: "{{data.email}}" } },
      {
        name: "fill",
        input: { ref: ref(page, "textbox", "Password"), value: "{{secret.SHOP_PASSWORD}}" },
      },
      { name: "click", input: { ref: ref(page, "button", "Sign up") } },
    ]),
  ],
  [/^Enter the code from the verification email and click "Verify"/, code(true)],
  [/^Enter the code from the verification email into/, code(false)],
  [/^Fill the card form with test card 4242/, card("4242 4242 4242 4242")],
  [/^Fill the card form with test card 4000/, card("4000 0000 0000 0002")],
];

const isCheckCall = (call: ScriptedCall) => promptText(call).includes("Expectation (");
const isJudgeCall = (call: ScriptedCall) => promptText(call).includes("Soft expectation:");

/** Agent calls go to the plans; check-compiler and judge calls to `checks` (default: no check). */
function script(checks?: (call: ScriptedCall) => ScriptedReply) {
  const agent = agentScript(PLANS);
  return (call: ScriptedCall): ScriptedReply => {
    if (isCheckCall(call) || isJudgeCall(call)) {
      return checks
        ? checks(call)
        : { text: JSON.stringify({ faithful: false, reason: "no check scripted", check: null }) };
    }
    return agent(call);
  };
}

// ── Fixture capture: observations and probes, per check step ─────────────────

interface Capture {
  test: string;
  line: string;
  observation: Observation | null;
  probes: Record<string, { passed: boolean; matched?: number }>;
  op?: CheckOp;
}

export const probeKey = (op: unknown): string =>
  JSON.stringify(op, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );

function capturing(session: Session, sink: { current: Capture | undefined }): Session {
  return new Proxy(session, {
    get(target, prop) {
      if (prop === "observe") {
        return async () => {
          const observation = await target.observe();
          if (sink.current && !sink.current.observation) sink.current.observation = observation;
          return observation;
        };
      }
      if (prop === "check") {
        return async (op: CheckOp, options?: CheckOptions) => {
          const result = await target.check(op, options);
          if (sink.current && (options?.on === undefined || options.on === "page")) {
            sink.current.probes[probeKey(op)] = {
              passed: result.passed,
              ...(result.matched !== undefined ? { matched: result.matched } : {}),
            };
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// ── Running the author ───────────────────────────────────────────────────────

let browser: LaunchedBrowser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser.close();
});

interface Authored {
  recording: Recording;
  report: AuthoringReport;
  calls: ScriptedCall[];
  captures: Capture[];
}

/** A private copy of the shop project (its saved sessions must not land in the fixture). */
function loginProject() {
  const dir = mkdtempSync(join(tmpdir(), "checks-login-"));
  cpSync(join(SHOP, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(SHOP, "tests"), join(dir, "tests"), {
    recursive: true,
    filter: (source) => !/\.ts$/.test(source),
  });
  return { dir, config: loadProject(dir, { environment: "local" }).config };
}

async function author(
  variant: Variant,
  test: string | ExpandedTest,
  checks?: (call: ScriptedCall) => ScriptedReply,
): Promise<Authored> {
  const shop = await startShop({ variant, port: 0 });
  try {
    let expanded: ExpandedTest;
    if (typeof test === "string") {
      const loaded = await loadTest(SHOP, test, undefined, { seed: "checks-e2e" });
      if (!loaded) throw new Error(`no ${test}`);
      expanded = loaded.expanded;
    } else expanded = test;
    const { models, calls } = scriptedModels(script(checks));
    const session = await openSession({
      browser,
      baseUrl: shop.url,
      allowedDomains: ["127.0.0.1"],
      secrets,
      allowUpload: { dir: `${SHOP}tests` },
    });
    const sink: { current: Capture | undefined } = { current: undefined };
    const captures: Capture[] = [];
    const checkSteps = new Map(
      expanded.steps
        .filter((s) => s.kind === "expect" || s.kind === "soft")
        .map((s) => [s.index, s]),
    );
    // auth: ada (SEC-3): logged in from the profile's committed flow recording, no AI.
    const login = expanded.auth && expanded.auth !== "none" ? loginProject() : undefined;
    const prepare = login
      ? authoringLogin({
          projectDir: login.dir,
          config: login.config,
          environment: "local",
          name: expanded.auth as string,
          profile: login.config.auth.profiles[expanded.auth as string] as never,
          session,
          openSession: (extra) =>
            openSession({
              browser,
              baseUrl: shop.url,
              allowedDomains: ["127.0.0.1"],
              secrets: { ...secrets, ...extra },
            }),
          replay: {
            mode: "replay-only",
            policy: "review",
            decisions: createDecisions(),
            fixerAvailable: false,
            plannerAvailable: false,
            production: false,
            newId: ulid,
          },
          meta: { engineVersion: "0.1.0", browser: "chromium", device: "desktop" },
        })
      : undefined;
    const result = await authorTest(expanded, {
      session: capturing(session, sink),
      ...(prepare ? { prepare } : {}),
      models,
      timeoutMs: 90_000,
      screenshots: false,
      meta: {
        testPath: expanded.path,
        target: "web",
        engineVersion: "0.1.0",
        device: "desktop",
        environment: "local",
      },
      onEvent: (event) => {
        if (event.type === "step.started") {
          const step = checkSteps.get(event.index);
          sink.current = step
            ? { test: expanded.path, line: step.text, observation: null, probes: {} }
            : undefined;
          if (sink.current) captures.push(sink.current);
        }
        if (event.type === "step.finished") sink.current = undefined;
      },
    });
    await session.close();
    if (login) rmSync(login.dir, { recursive: true, force: true });
    for (const capture of captures) {
      const op = result.recording.checks.find((c) => c.text === capture.line)?.check;
      if (op) capture.op = op;
      if (capture.observation) {
        capture.observation = JSON.parse(
          JSON.stringify({ ...capture.observation, observedAt: "" }).replaceAll(
            shop.url,
            "http://shop.test",
          ),
        );
      }
    }
    return { recording: result.recording, report: result.report, calls, captures };
  } finally {
    await shop.stop();
  }
}

const SHOP_TESTS = process.env.ONLY_SHOP_TEST
  ? [process.env.ONLY_SHOP_TEST]
  : [
      "tests/avatar-upload.test.md",
      "tests/billing-zero-due.test.md",
      "tests/checkout-trial.test.md",
      "tests/create-project.test.md",
      "tests/declined-card.test.md",
      "tests/delete-account-guard.test.md",
      "tests/login.test.md",
      "tests/settings-profile.test.md",
      "tests/signup-email-code.test.md",
      "tests/signup-validation.test.md",
      "tests/sort-orders.test.md",
    ];

describe("checks on the shop (LOOP-2)", () => {
  it("compiles every shop Expect line by rules, sanity-tests it and passes it on correct", async () => {
    const lines = new Map<string, CheckOp>();
    const captures: Capture[] = [];
    for (const test of SHOP_TESTS) {
      const { recording, report, calls, captures: own } = await author("correct", test);
      captures.push(...own);
      expect(
        report.outcome,
        `${test}: ${JSON.stringify(report.steps.map((s) => [s.text, s.status, s.message, s.actions]))}`,
      ).toBe("recorded");
      // No model was asked about any check.
      expect(calls.filter(isCheckCall), test).toEqual([]);
      for (const check of recording.checks) {
        const where = `${test}: ${check.text}`;
        expect(check.generatedBy, where).toBe("rules");
        expect(check.check.type, where).not.toBe("pending");
        expect(check.failedAtAuthoring, where).toBeUndefined();
        expect(check.problem, where).toBeUndefined();
        expect(check.sanity?.provesNothing, where).toBe(false);
        expect(check.sanity?.empty.result, where).toBe("failed");
        expect(check.summary, where).toMatch(/^Checked that /);
        lines.set(check.text, check.check);
      }
      // No check value ever contains a secret.
      expect(serializeRecording(recording)).not.toContain(PASSWORD);
      expect(JSON.stringify(report)).not.toContain(PASSWORD);
    }
    expect(lines.size).toBe(26);
    if (process.env.UPDATE_CHECK_FIXTURES) {
      mkdirSync(FIXTURES, { recursive: true });
      const seen = new Set<string>();
      const unique = captures.filter((c) => !seen.has(c.line) && seen.add(c.line));
      writeFileSync(`${FIXTURES}shop-correct.json`, `${JSON.stringify(unique, null, 2)}\n`);
    }
  });

  it("shows each compiled check and its sanity test in the create-project recording", async () => {
    const { recording } = await author("correct", "tests/create-project.test.md");
    expect(recording.checks.map((c) => [c.text, c.summary, c.sanity?.before.result])).toEqual([
      [
        'the page heading is "Dashboard"',
        "Checked that the main heading is exactly 'Dashboard'",
        "failed",
      ],
      [
        'a dialog titled "New project" is open',
        "Checked that the dialog 'New project' is visible",
        "failed",
      ],
      [
        'a message says "Project created"',
        "Checked that a status message contains 'Project created'",
        "failed",
      ],
      [
        'the projects list shows "Q3 roadmap"',
        "Checked that the list 'Projects' contains 'Q3 roadmap'",
        "failed",
      ],
      // After a reload the list looks the same as before it: nothing to compare against.
      [
        'the projects list shows "Q3 roadmap"',
        "Checked that the list 'Projects' contains 'Q3 roadmap'",
        "skipped",
      ],
    ]);
    if (process.env.UPDATE_CHECK_FIXTURES) {
      mkdirSync(FIXTURES, { recursive: true });
      writeFileSync(
        `${FIXTURES}create-project.checks.json`,
        `${JSON.stringify(
          recording.checks.map(({ recordedAt: _at, ...check }) => check),
          null,
          2,
        )}\n`,
      );
    }
  });

  it("fails the billing check on broken-total with the right expected and actual, and keeps it", async () => {
    const { recording, report } = await author("broken-total", "tests/billing-zero-due.test.md");
    const due = recording.checks.find((c) => c.text === 'the page shows "$0.00 due today"');
    expect(due).toMatchObject({
      generatedBy: "rules",
      check: { type: "text", match: "contains", value: "$0.00 due today" },
      failedAtAuthoring: { expected: "$0.00 due today", actual: "$29.00 due today" },
      sanity: { provesNothing: false },
    });
    const step = report.steps.find((s) => s.text === 'the page shows "$0.00 due today"');
    expect(step?.check).toMatchObject({ status: "failed", passed: false });
    expect(step?.message).toContain('expected "$0.00 due today", saw "$29.00 due today"');
    expect(report.checks.failedAtAuthoring).toBe(1);
  });

  it("fails the after-reload projects check on broken-not-saved", async () => {
    const { recording } = await author("broken-not-saved", "tests/create-project.test.md");
    // Two lines with the same text (before and after the reload): one check each.
    const lists = recording.checks.filter((c) => c.text === 'the projects list shows "Q3 roadmap"');
    expect(lists.map((c) => c.failedAtAuthoring ?? null)).toEqual([
      null,
      { expected: "Q3 roadmap", actual: "No projects yet." },
    ]);
    expect(recording.checks.filter((c) => c.failedAtAuthoring)).toHaveLength(1);
  });

  it("fails the sign-up heading check on broken-signup", async () => {
    const { recording, report } = await author("broken-signup", "tests/signup-email-code.test.md");
    const heading = recording.checks.find(
      (c) => c.text === 'the page heading is "Check your email"',
    );
    expect(heading).toMatchObject({
      generatedBy: "rules",
      failedAtAuthoring: { expected: "Check your email", actual: "Something went wrong" },
    });
    // The next step can't be done on the error page; later checks are not compiled.
    expect(report.outcome).toBe("failed");
  });

  it("rejects a check that proves nothing (regenerated once, then flagged) and accepts the real one", async () => {
    const flow = readFileSync(`${SHOP}tests/flows/login.test.md`, "utf8");
    const text =
      '---\nname: Weak\nstart: /login\nsetup:\n  - request: POST /__test/seed\n---\n\n1. Use: flows/login.test.md\n2. Go to the billing page\n3. Expect: the page shows "Acme"\n4. Expect: the page heading is "Billing"\n';
    const { spec } = parseTest(text, "tests/weak.test.md");
    const test = await expandTest(spec, {
      readFile: mapReader({ "tests/weak.test.md": text, "tests/flows/login.test.md": flow }),
      seed: "s",
    });
    const { recording, calls } = await author("correct", test, () => ({
      text: JSON.stringify({ faithful: false, reason: "Acme is on every page", check: null }),
    }));
    const weak = recording.checks.find((c) => c.text === 'the page shows "Acme"');
    expect(weak).toMatchObject({
      generatedBy: "rules",
      check: { type: "text", value: "Acme" },
      sanity: { empty: { result: "failed" }, before: { result: "passed" }, provesNothing: true },
    });
    expect(weak?.problem).toContain("before the preceding action");
    const real = recording.checks.find((c) => c.text === 'the page heading is "Billing"');
    expect(real).toMatchObject({ sanity: { provesNothing: false } });
    expect(real?.problem).toBeUndefined();
    // Exactly one regeneration attempt, for the weak line only.
    expect(calls.filter(isCheckCall)).toHaveLength(1);
    expect(promptText(calls.filter(isCheckCall)[0] as ScriptedCall)).toContain("<<<PAGE CONTENT");
  });

  it("uses the AI compiler for lines rules can't map, and soft judgments that only warn", async () => {
    const flow = readFileSync(`${SHOP}tests/flows/login.test.md`, "utf8");
    const text =
      '---\nname: AI\nstart: /login\nsetup:\n  - request: POST /__test/seed\n---\n\n1. Use: flows/login.test.md\n2. Go to the settings page\n3. Expect: you can press "Delete account"\n4. Soft: the settings page looks tidy\n';
    const { spec } = parseTest(text, "tests/ai.test.md");
    const test = await expandTest(spec, {
      readFile: mapReader({ "tests/ai.test.md": text, "tests/flows/login.test.md": flow }),
      seed: "s",
    });
    const { recording, report } = await author("correct", test, (call) => {
      const prompt = promptText(call);
      if (isJudgeCall(call))
        return { text: JSON.stringify({ answer: "yes", reason: "neat sections" }) };
      if (prompt.includes('"you can press \\"Delete account\\""'))
        return {
          text: JSON.stringify({
            faithful: true,
            reason: "an enabled button",
            check: {
              type: "element_state",
              target: { kind: "role", role: "button", name: "Delete account", exact: true },
              state: "enabled",
            },
          }),
        };
      return {
        text: JSON.stringify({
          faithful: true,
          reason: "visual",
          check: {
            type: "soft_judgment",
            question: "the settings page looks tidy",
            screenshot: "page",
          },
        }),
      };
    });
    expect(recording.checks.map((c) => [c.text, c.generatedBy, c.check.type])).toEqual([
      ['the page heading is "Dashboard"', "rules", "text"],
      ['you can press "Delete account"', "ai", "element_state"],
      ["the settings page looks tidy", "ai", "soft_judgment"],
    ]);
    expect(recording.checks[1]).toMatchObject({ sanity: { provesNothing: false } });
    expect(recording.checks[2]).toMatchObject({
      soft: true,
      summary:
        "Asked an AI model to judge a screenshot of the page: 'the settings page looks tidy' (soft check: it can only warn)",
      sanity: { provesNothing: false },
    });
    const soft = report.steps.find((s) => s.kind === "soft");
    expect(soft?.check).toMatchObject({ status: "passed", actual: "yes: neat sections" });
  });
});
