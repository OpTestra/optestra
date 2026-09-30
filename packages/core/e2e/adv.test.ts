import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { ENV_PREFIX } from "@testament/config";
import { startShop, type Variant } from "@testament/fixture-shop";
import { readRecording, recordingPath } from "@testament/recording/node";
import { afterAll, describe, expect, it } from "vitest";
import { agentScript, scriptedModels } from "../src/author/test-kit.test-support.js";
import { explainRun, formatExplanation } from "../src/explain/explain.js";
import { type RunTestsOptions, runTests } from "../src/run/runner.js";

// ADV-0 on the real shop: a dataset runs a test once per row (AUT-9), run:
// hooks go before and after a test, teardown even after a failure, with the
// secret never printed (AUT-10), and explain names the failing check and its
// evidence on a broken build (DIA-6).

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const PASSWORD = "shop-demo-pass";
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}, config = (text: string) => text): string {
  const dir = mkdtempSync(join(tmpdir(), "adv-e2e-"));
  dirs.push(dir);
  const file = join(dir, brand.configFileName);
  cpSync(join(SHOP, brand.configFileName), file);
  writeFileSync(file, config(readFileSync(file, "utf8")));
  cpSync(join(SHOP, "tests"), join(dir, "tests"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
    if (name.endsWith(".js")) chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

async function run(
  dir: string,
  variant: Variant,
  tests: string[],
  options: Partial<RunTestsOptions> = {},
) {
  const shop = await startShop({ variant, port: 0 });
  try {
    return await runTests({
      projectDir: dir,
      tests: tests.map((t) => join(dir, t)),
      retries: 0,
      video: false,
      generateSpecs: false,
      evidence: "full",
      mode: "replay-only",
      models: null,
      ...options,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        [`${ENV_PREFIX}BASE_URL`]: shop.url,
        SHOP_PASSWORD: PASSWORD,
      },
    });
  } finally {
    await shop.stop();
  }
}

const DATASET_TEST = `---
name: A named project is saved
start: /login
dataset: data/projects.csv
setup:
  - request: POST /__test/seed
  - run: scripts/setup.js
teardown:
  - run: scripts/teardown.js
---

1. Use: flows/login.test.md
2. Click "Create project"
3. Fill "Project name" with {{data.project}}
4. Click "Create"
5. Expect: the projects list shows "{{data.project}}"
`;

const HOOKS = {
  "scripts/setup.js": `#!/usr/bin/env node
require("node:fs").appendFileSync(__dirname + "/../hooks.log", "setup\\n");
console.log("password is " + process.env.SHOP_PASSWORD);`,
  "scripts/teardown.js": `#!/usr/bin/env node
require("node:fs").appendFileSync(__dirname + "/../hooks.log", "teardown\\n");
console.log("teardown with " + process.env.SHOP_PASSWORD); process.exit(4);`,
};

const allowScripts = (text: string) =>
  `${text}\nhooks:\n  run:\n    allow: ["scripts/*.js"]\n    timeoutSeconds: 20\n`;

describe("datasets and hooks on the shop", () => {
  it("runs a 3-row dataset as 3 results: the first row records with AI, the others replay with none", async () => {
    const dir = project(
      {
        "tests/create-named.test.md": DATASET_TEST,
        "tests/data/projects.csv": 'project\nQ3 roadmap\nHiring plan\n"Budget, 2027"\n',
        ...HOOKS,
      },
      allowScripts,
    );
    const { models, calls } = scriptedModels(
      agentScript([
        [/^Go to \/login/, [{ name: "goto", input: { url: "/login" } }]],
        [
          /^Fill "Email"/,
          [
            {
              name: "fill",
              on: { role: "textbox", name: "Email" },
              input: { value: "{{params.email}}" },
            },
          ],
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
              input: { value: "{{data.project}}" },
            },
          ],
        ],
        [/^Click "Create"$/, [{ name: "click", on: { role: "button", name: "Create" } }]],
      ]),
    );
    const logs: string[] = [];
    const result = await run(dir, "correct", ["tests/create-named.test.md"], {
      mode: "normal",
      models,
      onEvent: (event) => {
        if (event.type === "log") logs.push(event.message);
      },
    });
    expect(result.tests.map((t) => [t.testId, t.name, t.verdict])).toEqual([
      ["tests__create-named#1", "A named project is saved #1", "passed"],
      ["tests__create-named#2", "A named project is saved #2", "passed"],
      ["tests__create-named#3", "A named project is saved #3", "passed"],
    ]);
    expect(result.tests.map((t) => t.ai.calls > 0)).toEqual([true, false, false]);
    expect(calls.length).toBe(result.tests[0]?.ai.calls);
    // Each row checked its own value.
    const checked = result.tests.map(
      (t) => t.attempts[0]?.checks.find((c) => c.expectation.includes("projects list"))?.actual,
    );
    expect(checked.join(" | ")).toMatch(/Q3 roadmap.*\|.*Hiring plan.*\|.*Budget, 2027/);
    // One recording for every row, with the column as a template.
    const recording = readRecording(recordingPath(join(dir, "tests"), "tests__create-named"));
    expect(recording?.ok).toBe(true);
    const fill = recording?.ok
      ? recording.recording.steps.find((s) => s.text.startsWith('Fill "Project name"'))?.commands[0]
          ?.action
      : undefined;
    expect(fill).toMatchObject({ type: "fill", value: "{{data.project}}" });
    // Setup and teardown ran for every row; teardown's failure is only a warning.
    expect(readFileSync(join(dir, "hooks.log"), "utf8")).toBe(
      "setup\nteardown\nsetup\nteardown\nsetup\nteardown\n",
    );
    expect(
      logs.filter((l) => l.startsWith("Teardown run scripts/teardown.js failed")),
    ).toHaveLength(3);
    // The secret the scripts printed is never shown.
    const everything = [JSON.stringify(result.tests), ...logs].join("\n");
    expect(everything).toContain("teardown with [secret:SHOP_PASSWORD]");
    expect(everything).not.toContain(PASSWORD);
  });

  it("runs teardown after a failed test, and blocks a test whose run: hook isn't allowed", async () => {
    const dir = project({ "tests/create-named.test.md": DATASET_TEST, ...HOOKS }, (t) => t);
    mkdirSync(join(dir, "tests/data"), { recursive: true });
    const refused = await run(dir, "correct", ["tests/create-named.test.md"]);
    // No dataset file: blocked, with the fix.
    expect(refused.tests[0]?.verdict).toBe("blocked");
    expect(refused.tests[0]?.headline).toMatch(/DATASET_NOT_FOUND.*data\/projects\.csv/);

    writeFileSync(join(dir, "tests/data/projects.csv"), "project\nQ3 roadmap\n");
    const notAllowed = await run(dir, "correct", ["tests/create-named.test.md"]);
    expect(notAllowed.tests[0]?.verdict).toBe("blocked");
    expect(notAllowed.tests[0]?.headline).toMatch(/not an allowed command.*hooks\.run\.allow/);

    const allowed = project(
      {
        "tests/login-hooks.test.md": readFileSync(
          join(SHOP, "tests/login.test.md"),
          "utf8",
        ).replace("timeout: 1m", "timeout: 1m\nteardown:\n  - run: scripts/teardown.js"),
        ...HOOKS,
      },
      allowScripts,
    );
    cpSync(
      join(allowed, "tests", brand.dataDirName, "tests__login.steps.json"),
      join(allowed, "tests", brand.dataDirName, "tests__login-hooks.steps.json"),
    );
    const failed = await run(allowed, "broken-login-redirect", ["tests/login-hooks.test.md"]);
    expect(failed.tests[0]?.verdict).toBe("failed");
    expect(readFileSync(join(allowed, "hooks.log"), "utf8")).toBe("teardown\n");
  });
});

describe("explain on the shop", () => {
  it("names the failing check and the $29.00 vs $0.00 evidence of broken-total, rules only", async () => {
    const dir = project();
    const result = await run(dir, "broken-total", ["tests/billing-zero-due.test.md"]);
    expect(result.tests[0]?.verdict).toBe("failed");
    const explained = await explainRun(result.dir);
    const [e] = explained.explanations;
    expect(e?.mode).toBe("rules");
    expect(e?.cause).toBe(result.tests[0]?.failureCause);
    expect(e?.diagnosis).toMatch(
      /The check "the page shows "\$0\.00 due today"" failed \[E1\]: it expected "\$0\.00 due today" and the page showed ".*\$29\.00 due today/,
    );
    expect(e?.evidence.map((x) => x.kind)).toEqual(
      expect.arrayContaining(["check", "screenshot", "trace"]),
    );
    const text = formatExplanation(e as NonNullable<typeof e>);
    expect(text).toContain("Explained by rules (no AI)");
    for (const item of e?.evidence ?? []) if (item.path) expect(existsSync(item.path)).toBe(true);
  });
});
