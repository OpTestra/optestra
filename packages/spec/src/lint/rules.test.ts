import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "@testament/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkTest } from "../check.js";
import { mapReader } from "../expand.js";
import { loadTests } from "../node/index.js";
import { LINT_RULES } from "./rules.js";
import { RULE_IDS, type RuleId } from "./types.js";
import { BUILT_IN_WORDS } from "./words.js";

const LOGIN_FLOW = `---
name: Log in
kind: flow
---

1. Go to /login
2. Fill "Email" with ada@example.com
3. Click "Log in"
`;
const DELETE_FLOW = `---
name: Remove project
kind: flow
---

1. Click "Delete project"
`;

const doc = (front: string[], body: string[]) =>
  `---\n${front.join("\n")}\n---\n\n${body.join("\n")}\n`;
const std = (body: string[], front: string[] = []) => doc(["name: T", "start: /x", ...front], body);

async function lint(text: string, config?: Parameters<typeof checkTest>[2]["config"]) {
  const { findings } = await checkTest(text, "tests/t.test.md", {
    readFile: mapReader({
      "tests/flows/login.test.md": LOGIN_FLOW,
      "tests/flows/delete.test.md": DELETE_FLOW,
    }),
    config,
  });
  return findings;
}
const rules = async (text: string) => (await lint(text)).map((f) => f.rule ?? f.code);

// Every rule: files that must fire it, and files that must not.
const CASES: Record<
  Exclude<RuleId, "duplicate-test-name" | "unused-flow">,
  { bad: string[]; good: string[] }
> = {
  "vague-step": {
    bad: [
      std(["1. Log in normally", '2. Expect: the heading is "Hi"']),
      std(["1. Do the usual", '2. Expect: the heading is "Hi"']),
      std(["1. Set things up", '2. Expect: the heading is "Hi"']),
      std(["1. Check it works", '2. Expect: the heading is "Hi"']),
      std(["1. Click it", '2. Expect: the heading is "Hi"']),
      std(["1. Tap", '2. Expect: the heading is "Hi"']),
      std(["1. Swipe it", '2. Expect: the heading is "Hi"']),
    ],
    good: [
      std([
        '1. Click "Log in"',
        '2. Tap "Continue"',
        "3. Swipe left on the card",
        '4. Expect: the heading is "Hi"',
      ]),
      std(["1. Use: flows/login.test.md", '2. Expect: the heading is "Hi"']),
    ],
  },
  "expect-not-observable": {
    bad: [
      std(["1. Go to /x", "2. Expect: it works"]),
      std(["1. Go to /x", "2. Expect: the page is correct"]),
    ],
    good: [
      std(
        [
          "1. Go to /x",
          '2. Expect: the heading is "Hi"',
          "3. Expect: the URL contains /done",
          "4. Expect: the orders table shows 5 orders",
          "5. Expect: the Save button is disabled",
          "6. Expect: {{data.email}} is shown",
        ],
        ["data:", "  email: a@b.test"],
      ),
    ],
  },
  "no-expectations": {
    bad: [std(['1. Click "Start"']), std(['1. Click "Start"', "2. Expect: it works"])],
    good: [
      std(['1. Click "Start"', '2. Expect: the heading is "Done"']),
      std(['1. Click "Start"', "2. Exact: expect url contains /done"]),
      doc(["name: Flow", "kind: flow"], ['1. Click "Start"']),
    ],
  },
  "soft-only": {
    bad: [std(['1. Click "Start"', "2. Soft: the chart looks reasonable"])],
    good: [
      std([
        '1. Click "Start"',
        '2. Expect: the heading is "Chart"',
        "3. Soft: the chart looks reasonable",
      ]),
    ],
  },
  "missing-start": {
    bad: [doc(["name: T"], ['1. Click "Start"', '2. Expect: the heading is "Hi"'])],
    good: [
      doc(["name: T"], ["1. Go to /pricing", '2. Expect: the heading is "Hi"']),
      doc(["name: T"], ["1. Exact: goto /pricing", '2. Expect: the heading is "Hi"']),
      doc(["name: T"], ["1. Use: flows/login.test.md", '2. Expect: the heading is "Hi"']),
      doc(["name: T"], ["1. Open the app", '2. Expect: the heading is "Hi"']),
    ],
  },
  "compound-expect": {
    bad: [std(["1. Go", '2. Expect: the page shows "Pro plan" and the URL contains /billing'])],
    good: [
      std(["1. Go", "2. Expect: the terms and conditions link is shown"]),
      std(["1. Go", '2. Expect: the text "Terms and conditions" is shown']),
    ],
  },
  "literal-credential": {
    bad: [
      std(['1. Fill "Password" with hunter2hunter2', '2. Expect: the heading is "Hi"']),
      std([
        "1. Sign up with ada@example.com and password S3cret!pass",
        '2. Expect: the heading is "Hi"',
      ]),
      std([
        '1. Exact: fill label="Password" with "hunter2hunter2"',
        '2. Expect: the heading is "Hi"',
      ]),
      std(["1. Set the header to sk_live_abcdefghijklmnop", '2. Expect: the heading is "Hi"']),
      std(
        ['1. Click "Go"', '2. Expect: the heading is "Hi"'],
        ["data:", "  adminPassword: hunter2hunter2"],
      ),
    ],
    good: [
      std(['1. Fill "Password" with {{secret.TEST_PASSWORD}}', '2. Expect: the heading is "Hi"']),
      std([
        '1. Fill "Password" with short',
        '2. Expect: the text "Password must be at least 8 characters." is shown',
      ]),
      std(['1. Fill "Password confirmation" with {{secret.PW}}', '2. Expect: the heading is "Hi"']),
      std(["1. Enter the password for the admin account", '2. Expect: the heading is "Hi"']),
    ],
  },
  "fixed-email": {
    bad: [
      std(["1. Sign up with ada@example.com", '2. Expect: the heading is "Hi"']),
      doc(
        ["name: New user signs up", "start: /signup"],
        ['1. Fill "Email" with ada@example.com', '2. Expect: the heading is "Hi"'],
      ),
    ],
    good: [
      std([
        '1. Fill "Email" with ada@example.com',
        '2. Click "Log in"',
        '3. Expect: the heading is "Hi"',
      ]),
      std(
        ["1. Sign up with {{data.email}}", '2. Expect: the heading is "Hi"'],
        ["data:", '  email: "{{unique.email}}"'],
      ),
    ],
  },
  "destructive-undeclared": {
    bad: [
      std(['1. Click "Delete project"', '2. Expect: the heading is "Hi"']),
      std(['1. Click "Pay now"', '2. Expect: the heading is "Hi"']),
      std(["1. Cancel the subscription", '2. Expect: the heading is "Hi"']),
      std(["1. Use: flows/delete.test.md", '2. Expect: the heading is "Hi"']),
    ],
    good: [
      std(
        ['1. Click "Delete project"', '2. Expect: the heading is "Hi"'],
        ["allowDestructive: [delete]"],
      ),
      std(['1. Click "Cancel"', "2. Expect: the dialog is closed"]),
      std([
        '1. Click "Save"',
        'Never: click "Delete account"',
        '2. Expect: a "Delete account" button is shown',
      ]),
    ],
  },
  "vague-guard": {
    bad: [std(['1. Click "Go"', '2. Expect: the heading is "Hi"', "Never: break anything"])],
    good: [
      std([
        '1. Click "Go"',
        '2. Expect: the heading is "Hi"',
        'Never: click "Delete account"',
        "Never: go to /admin",
      ]),
    ],
  },
  "fixed-wait": {
    bad: [
      std(['1. Click "Go"', "2. Wait 5 seconds", '3. Expect: the heading is "Hi"']),
      std(['1. Click "Go"', "2. Sleep for 500ms", '3. Expect: the heading is "Hi"']),
      std([
        '1. Click "Go"',
        "2. ```ts",
        "   await page.waitForTimeout(500);",
        "   ```",
        '3. Expect: the heading is "Hi"',
      ]),
    ],
    good: [
      std(['1. Click "Go"', '2. Wait for the message "Saved"', '3. Expect: the heading is "Hi"']),
    ],
  },
};

describe("lint rules", () => {
  for (const [rule, { bad, good }] of Object.entries(CASES)) {
    it.each(bad.map((text, i) => [i, text]))(
      `${rule} fires on bad example %i`,
      async (_i, text) => {
        expect(await rules(text)).toContain(rule);
      },
    );
    it.each(good.map((text, i) => [i, text]))(
      `${rule} stays quiet on good example %i`,
      async (_i, text) => {
        expect(await rules(text)).not.toContain(rule);
      },
    );
  }

  it("every rule has docs, a default severity and a case", () => {
    expect(LINT_RULES.map((r) => r.id)).toEqual([...RULE_IDS]);
    for (const rule of LINT_RULES) {
      expect(rule.summary.length, rule.id).toBeGreaterThan(10);
      expect(rule.why.length, rule.id).toBeGreaterThan(20);
      expect(rule.bad && rule.good, rule.id).toBeTruthy();
      expect(["error", "warning", "info"]).toContain(rule.severity);
      if (rule.check) expect(Object.keys(CASES), rule.id).toContain(rule.id);
    }
  });

  it("finds the acceptance problems with exact ranges", async () => {
    const findings = await lint(
      doc(
        ["name: Weak test", "start: /login"],
        ["1. Log in normally", '2. Fill "Password" with hunter2hunter2', "3. Expect: it works"],
      ),
    );
    expect(findings.map((f) => [f.rule, f.severity, f.range])).toEqual([
      ["no-expectations", "error", { start: { line: 2, column: 1 }, end: { line: 2, column: 16 } }],
      ["vague-step", "warning", { start: { line: 6, column: 4 }, end: { line: 6, column: 19 } }],
      [
        "literal-credential",
        "warning",
        { start: { line: 7, column: 25 }, end: { line: 7, column: 39 } },
      ],
      [
        "expect-not-observable",
        "warning",
        { start: { line: 8, column: 12 }, end: { line: 8, column: 20 } },
      ],
    ]);
    for (const f of findings) {
      expect(f.code).toBe("LINT");
      expect(f.fix.length).toBeGreaterThan(10);
    }
  });

  it("offers a secret for a literal credential, never as a safe fix", async () => {
    const [finding] = (
      await lint(std(['1. Fill "Password" with hunter2hunter2', '2. Expect: the heading is "Hi"']))
    ).filter((f) => f.rule === "literal-credential");
    expect(finding?.fix).toContain("secrets:\n  PASSWORD: { domains: [");
    expect(finding?.fixes).toEqual([
      {
        title: "Use {{secret.PASSWORD}} instead",
        edits: [{ range: finding?.range, newText: "{{secret.PASSWORD}}" }],
        safe: false,
      },
    ]);
  });

  it("reports destructive steps from flows on the Use: line", async () => {
    const [finding] = (
      await lint(std(["1. Use: flows/delete.test.md", '2. Expect: the heading is "Hi"']))
    ).filter((f) => f.rule === "destructive-undeclared");
    expect(finding?.range?.start.line).toBe(6);
    expect(finding?.message).toContain("tests/flows/delete.test.md");
    expect(finding?.message).toContain("Blocked");
  });
});

describe("rule levels", () => {
  const config = (lint: unknown) =>
    resolveConfig({ project: { version: 1, project: { name: "x", target: "web" }, lint } }).config;

  it("has defaults registered in the config", () => {
    expect(config(undefined).lint).toEqual({ rules: {}, strict: false });
  });

  it("turns rules off and changes their severity", async () => {
    const text = std(["1. Log in normally", '2. Expect: the heading is "Hi"', "3. Wait 2 seconds"]);
    const findings = await lint(
      text,
      config({ rules: { "vague-step": "off", "fixed-wait": "error" } }),
    );
    expect(findings.map((f) => [f.rule, f.severity])).toEqual([["fixed-wait", "error"]]);
  });

  it("doesn't ask Android tests for a start page (the app starts at its launcher)", async () => {
    const text = doc(["name: T"], ['1. Tap "Sign in"', '2. Expect: the heading is "Hi"']);
    const android = resolveConfig({
      project: {
        version: 1,
        project: { name: "x", target: "android" },
        environments: { local: { app: "app.apk" } },
      },
    }).config;
    const rules = (findings: { rule?: string }[]) => findings.map((f) => f.rule);
    expect(rules(await lint(text, config(undefined)))).toContain("missing-start");
    expect(rules(await lint(text, android))).not.toContain("missing-start");
  });

  it("rejects unknown levels", () => {
    const { diagnostics } = resolveConfig({
      project: {
        version: 1,
        project: { name: "x", target: "web" },
        lint: { rules: { "vague-step": "loud" } },
      },
    });
    expect(diagnostics.map((d) => [d.code, d.path])).toContainEqual([
      "INVALID_VALUE",
      "lint.rules.vague-step",
    ]);
  });
});

describe("the demo shop", () => {
  it("lints with zero findings", async () => {
    const shop = fileURLToPath(new URL("../../../../bench/fixtures/shop/", import.meta.url));
    const loaded = await loadTests(shop, undefined);
    const { nodeFileReader } = await import("../node/index.js");
    for (const test of [...loaded.tests, ...loaded.flows]) {
      const text = readFileSync(`${shop}${test.path}`, "utf8");
      const { findings } = await checkTest(text, test.path, { readFile: nodeFileReader(shop) });
      expect(findings, test.path).toEqual([]);
    }
  });
});

describe("word lists", () => {
  it("words.generated.ts matches lint-words.yaml (run `pnpm --filter ./packages/spec gen:words`)", () => {
    const yaml = parse(readFileSync(new URL("../../lint-words.yaml", import.meta.url), "utf8"));
    expect(BUILT_IN_WORDS).toEqual(yaml);
  });
});
