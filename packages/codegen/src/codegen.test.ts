import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { expandTest, mapReader, parseTest } from "@optestra/spec";
import { afterAll, describe, expect, it } from "vitest";
import { composeProject, GOLDEN_DIR } from "./fixture-project.test-support.js";
import { fileState, withHeader } from "./header.js";
import { type GenerateProjectResult, generateProject } from "./node/index.js";
import { quote } from "./print/js.js";
import { readCodegenRecording } from "./recording.js";
import { CHECKED_ELSEWHERE, generateSpec } from "./spec.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const PLANTED = "planted-S3cret-value-9f2c";

async function generated(extra: { env?: Record<string, string> } = {}) {
  const dir = composeProject();
  temps.push(dir);
  writeFileSync(join(dir, ".env"), `SHOP_PASSWORD=${PLANTED}\n`);
  const result = await generateProject({
    projectDir: dir,
    env: { SHOP_PASSWORD: PLANTED, ...extra.env },
  });
  const out = join(dir, "tests", brand.dataDirName);
  const files = Object.fromEntries(
    readdirSync(out)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => [name, readFileSync(join(out, name), "utf8")]),
  );
  return { dir, out, result, files };
}

const statuses = (result: GenerateProjectResult) =>
  Object.fromEntries(result.files.map((file) => [file.path.split("/").pop(), file.status]));

describe("generated specs (goldens)", async () => {
  const { result, files } = await generated();

  it("generates a spec for every recorded test, plus the fixtures and config", () => {
    expect(result.ok).toBe(true);
    expect(Object.keys(files)).toEqual(
      [
        "playwright.config.ts",
        `${brand.cliName}.fixtures.ts`,
        `${brand.cliName}.reporter.ts`,
        `${brand.cliName}.teardown.ts`,
        "tests__allowed-hosts.spec.ts",
        "tests__avatar-upload.spec.ts",
        "tests__billing-zero-due.spec.ts",
        "tests__checkout-trial.spec.ts",
        "tests__create-project.spec.ts",
        "tests__delete-account-guard.spec.ts",
        "tests__settings-profile.spec.ts",
        "tests__sort-orders.spec.ts",
      ].sort(),
    );
    expect(result.skipped.map((s) => s.test)).toEqual([
      "tests/declined-card.test.md",
      "tests/login.test.md",
      "tests/signup-email-code.test.md",
      "tests/signup-validation.test.md",
    ]);
  });

  for (const [name, content] of Object.entries(files)) {
    it(`matches the golden ${name}`, async () => {
      await expect(content).toMatchFileSnapshot(join(GOLDEN_DIR, name));
    });
  }

  it("imports only @playwright/test, the fixtures module and Node built-ins", () => {
    for (const [name, content] of Object.entries(files)) {
      expect(content, name).not.toMatch(new RegExp(`${brand.npmScope}/`));
      const sources = [...content.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      for (const source of sources) {
        expect(source, name).toMatch(
          new RegExp(
            `^(@playwright/test(/reporter)?|\\./${brand.cliName}\\.(fixtures|reporter)|node:[a-z]+)$`,
          ),
        );
      }
    }
  });

  it("never contains a secret value, only secret names", () => {
    for (const [name, content] of Object.entries(files))
      expect(content, name).not.toContain(PLANTED);
    expect(files["tests__create-project.spec.ts"]).toContain(
      'await secrets.fill(page.getByLabel("Password", { exact: true }), "SHOP_PASSWORD");',
    );
  });

  it("has no fixed sleeps, only web-first waits", () => {
    for (const [name, content] of Object.entries(files)) {
      expect(content, name).not.toMatch(/waitForTimeout|setTimeout\(\s*\(|sleep\(/);
    }
    expect(files["tests__settings-profile.spec.ts"]).toContain(
      'await expect(page).toHaveURL(route("/settings"));',
    );
  });

  it("notes checks it can't run instead of failing or passing on them", () => {
    const spec = files["tests__allowed-hosts.spec.ts"] ?? "";
    expect(spec).toContain(
      `${CHECKED_ELSEWHERE}("Soft: the sign-up form looks tidy", "a model judges it");`,
    );
  });

  it("is byte-identical when generated again", async () => {
    const again = await generated();
    expect(again.files).toEqual(files);
  });

  it("type-checks as plain Playwright code under strict settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-tsc-"));
    temps.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    mkdirSync(join(dir, "node_modules", "@playwright"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "@types"), { recursive: true });
    const here = fileURLToPath(new URL("..", import.meta.url));
    symlinkSync(
      realpathSync(join(here, "node_modules", "@playwright", "test")),
      join(dir, "node_modules", "@playwright", "test"),
      "junction",
    );
    symlinkSync(
      realpathSync(join(root, "node_modules", "@types", "node")),
      join(dir, "node_modules", "@types", "node"),
      "junction",
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          types: ["node"],
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["*.ts"],
      }),
    );
    const tsc = spawnSync(
      process.execPath,
      [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", dir],
      { encoding: "utf8" },
    );
    expect(`${tsc.stdout}${tsc.stderr}`).toBe("");
    expect(tsc.status).toBe(0);
  }, 60_000);
});

describe("regeneration", () => {
  it("leaves unchanged files alone", async () => {
    const { dir } = await generated();
    const second = await generateProject({ projectDir: dir, env: {} });
    expect(new Set(Object.values(statuses(second)))).toEqual(new Set(["unchanged"]));
  });

  it("refuses to overwrite a hand-edited spec without --force, and says which file", async () => {
    const { dir, out } = await generated();
    const file = join(out, "tests__create-project.spec.ts");
    const edited = readFileSync(file, "utf8").replace("Q3 roadmap", "Q4 roadmap");
    writeFileSync(file, edited);
    // The recording changes too, so the spec is stale as well as edited.
    const recordingFile = join(out, "tests__create-project.steps.json");
    writeFileSync(
      recordingFile,
      readFileSync(recordingFile, "utf8").replaceAll('"Q3 roadmap"', '"Q3 plan"'),
    );

    const refused = await generateProject({ projectDir: dir, env: {} });
    expect(refused.files).toContainEqual({
      path: `tests/${brand.dataDirName}/tests__create-project.spec.ts`,
      status: "edited",
      test: "tests/create-project.test.md",
    });
    expect(readFileSync(file, "utf8")).toBe(edited);

    const check = await generateProject({ projectDir: dir, env: {}, check: true });
    expect(statuses(check)["tests__create-project.spec.ts"]).toBe("edited");

    const forced = await generateProject({ projectDir: dir, env: {}, force: true });
    expect(statuses(forced)["tests__create-project.spec.ts"]).toBe("overwritten");
    expect(readFileSync(file, "utf8")).toContain('.fill("Q3 plan")');
  });

  it("reports stale specs in check mode without writing", async () => {
    const { dir, out } = await generated();
    const recordingFile = join(out, "tests__sort-orders.steps.json");
    writeFileSync(
      recordingFile,
      readFileSync(recordingFile, "utf8").replace('"A-1002"', '"A-1003"'),
    );
    const before = readFileSync(join(out, "tests__sort-orders.spec.ts"), "utf8");
    const check = await generateProject({ projectDir: dir, env: {}, check: true });
    expect(statuses(check)["tests__sort-orders.spec.ts"]).toBe("stale");
    expect(statuses(check)["tests__create-project.spec.ts"]).toBe("unchanged");
    expect(readFileSync(join(out, "tests__sort-orders.spec.ts"), "utf8")).toBe(before);
  });

  it("generates only the tests asked for", async () => {
    const { dir } = await generated();
    const one = await generateProject({
      projectDir: dir,
      env: {},
      tests: ["tests/create-project.test.md"],
    });
    expect(one.files.map((f) => f.path.split("/").pop())).toEqual([
      "tests__create-project.spec.ts",
      `${brand.cliName}.fixtures.ts`,
      `${brand.cliName}.reporter.ts`,
      `${brand.cliName}.teardown.ts`,
      "playwright.config.ts",
    ]);
  });

  it("detects edits anywhere in a file through the content hash", () => {
    const content = withHeader("export const x = 1;\n", { from: "tests/x.test.md" });
    expect(fileState(content)).toBe("generated");
    expect(fileState(content.replace("x = 1", "x = 2"))).toBe("edited");
    expect(fileState(content.replace("tests/x.test.md", "tests/y.test.md"))).toBe("edited");
    expect(fileState("export const x = 1;\n")).toBe("foreign");
  });
});

// ── single specs from synthetic recordings ──────────────────────────────────

const base = {
  recordingVersion: 1,
  testId: "tests__t",
  testPath: "tests/t.test.md",
  target: "web",
  recordedWith: {
    engineVersion: "0.1.0",
    epoch: 1,
    browser: "chromium",
    device: "laptop",
    environment: null,
    model: null,
    promptVersion: null,
  },
  updatedAt: "2026-09-26T00:00:00.000Z",
};

async function specFor(
  files: Record<string, string>,
  steps: Array<{ text: RegExp; commands: unknown[] }>,
  checks: Array<{ text: RegExp; check: unknown; soft?: boolean; generatedBy?: string }> = [],
) {
  const path = "tests/t.test.md";
  const parsed = parseTest(files[path] as string, path);
  const expanded = await expandTest(parsed.spec, { readFile: mapReader(files), seed: "s" });
  const specs = Object.fromEntries(
    Object.entries(files).map(([file, text]) => [file, parseTest(text, file).spec]),
  );
  const at = "2026-09-26T00:00:00.000Z";
  const raw = {
    ...base,
    steps: expanded.steps
      .filter((step) => step.kind === "action" && steps.some((s) => s.text.test(step.text)))
      .map((step) => ({
        key: "0000000000000000",
        textKey: step.textKey,
        route: "/",
        text: step.text,
        kind: "action",
        commands: steps.find((s) => s.text.test(step.text))?.commands ?? [],
        source: "ai",
        recordedAt: at,
      })),
    checks: expanded.steps
      .filter((step) => step.kind === "expect" || step.kind === "soft")
      .map((step) => {
        const found = checks.find((c) => c.text.test(step.text));
        return {
          key: "0000000000000000",
          textKey: step.textKey,
          text: step.text,
          soft: step.kind === "soft",
          check: found?.check ?? { type: "pending" },
          generatedBy: found?.generatedBy ?? "ai",
          recordedAt: at,
        };
      }),
  };
  const recording = readCodegenRecording(raw);
  if (!recording.ok) throw new Error(recording.error);
  return generateSpec(recording.recording, { expanded, specs }).content;
}

const command = (action: unknown, expectPost: unknown = {}) => ({
  action,
  fingerprint: null,
  expectPost,
  wait: { settledMs: 0, waitedFor: { network: 0, dom: 0, busy: 0 } },
});

describe("values", () => {
  it("declares data once per test, generators called at run time, data using data", async () => {
    const spec = await specFor(
      {
        "tests/t.test.md": [
          "---",
          "name: t",
          "data:",
          '  email: "{{unique.email}}"',
          '  greeting: "Hi {{data.email}}"',
          "  unused: nothing",
          "---",
          "1. Fill Email with {{data.email}}",
          "2. Fill Note with {{data.greeting}} from {{env.REGION}}",
        ].join("\n"),
      },
      [
        {
          text: /^Fill Email/,
          commands: [
            command({
              type: "fill",
              target: { kind: "label", text: "Email" },
              value: "{{data.email}}",
            }),
          ],
        },
        {
          text: /^Fill Note/,
          commands: [
            command({
              type: "fill",
              target: { kind: "label", text: "Note" },
              value: "{{data.greeting}} from {{env.REGION}}",
            }),
          ],
        },
      ],
    );
    expect(spec).toContain("const dataEmail = values.unique.email();");
    expect(spec).toContain("const data = { email: dataEmail, greeting: `Hi $" + "{dataEmail}` };");
    expect(spec).not.toContain("unused");
    expect(spec).toContain(".fill(`$" + "{data.greeting} from $" + '{values.env("REGION")}`);');
  });

  it("passes flow params from the caller and keeps secrets as names", async () => {
    const spec = await specFor(
      {
        "tests/t.test.md": [
          "---",
          "name: t",
          "data:",
          '  who: "{{faker.email}}"',
          "---",
          `1. Use: flows/in.test.md { email: "{{data.who}}" }`,
        ].join("\n"),
        "tests/flows/in.test.md": [
          "---",
          "name: Sign in",
          "kind: flow",
          "params:",
          "  email: null",
          '  password: "{{secret.PASS}}"',
          "---",
          "1. Fill Email with {{params.email}}",
          "2. Fill Password with {{params.password}}",
        ].join("\n"),
      },
      [
        {
          text: /^Fill Email/,
          commands: [
            command({
              type: "fill",
              target: { kind: "label", text: "Email" },
              value: "{{params.email}}",
            }),
          ],
        },
        {
          text: /^Fill Password/,
          commands: [
            command({
              type: "fill",
              target: { kind: "label", text: "Password" },
              value: "{{params.password}}",
            }),
          ],
        },
      ],
    );
    expect(spec).toContain("const data = { who: values.faker.email() };");
    expect(spec).toContain("const inParams = { email: data.who };");
    expect(spec).toContain('await test.step("Sign in (flows/in.test.md)", async () => {');
    expect(spec).toContain(
      'await secrets.fill(page.getByLabel("Password", { exact: true }), "PASS");',
    );
  });

  it("skips a step whose value it can't produce, with the reason", async () => {
    const spec = await specFor(
      { "tests/t.test.md": "---\nname: t\n---\n1. Fill Code with x{{secret.PASS}}" },
      [
        {
          text: /^Fill Code/,
          commands: [
            command({
              type: "fill",
              target: { kind: "label", text: "Code" },
              value: "x{{secret.PASS}}",
            }),
          ],
        },
      ],
    );
    expect(spec).toContain("test.skip(\n");
    expect(spec).toContain(
      `"This step types a value the spec can't produce: a secret must be the whole value, typed on its own",`,
    );
  });

  it("skips a step that was never recorded, telling how to record it", async () => {
    const spec = await specFor({ "tests/t.test.md": "---\nname: t\n---\n1. Click Go" }, []);
    expect(spec).toContain(
      `Step 1 is not recorded yet: run \`${brand.cliName} author tests/t.test.md\``,
    );
  });
});

describe("checks", () => {
  const file = [
    "---",
    "name: t",
    "---",
    "1. Expect: A",
    "2. Soft: B",
    "3. Expect: C",
    "4. Expect: D",
    "5. Expect: E",
    "6. Expect: F",
    "7. Expect: G",
  ].join("\n");

  it("maps each op to a web-first assertion; soft checks use expect.soft", async () => {
    const spec = await specFor(
      { "tests/t.test.md": file },
      [],
      [
        { text: /^A$/, check: { type: "url", match: "matches", value: "/orders/\\d+" } },
        {
          text: /^B$/,
          check: {
            type: "element_state",
            target: { kind: "role", role: "checkbox", name: "Terms" },
            state: "unchecked",
          },
        },
        {
          text: /^C$/,
          check: { type: "count", target: { kind: "testId", value: "row" }, min: 2, max: 4 },
        },
        { text: /^D$/, check: { type: "network", method: "post", url: "/api/**", status: 201 } },
        {
          text: /^E$/,
          check: {
            type: "aria_snapshot",
            target: { kind: "role", role: "list" },
            snapshot: "- listitem: One",
          },
        },
        { text: /^F$/, check: { type: "code", code: 'expect(await page.title()).toBe("Shop");' } },
        {
          text: /^G$/,
          check: {
            type: "text",
            target: { kind: "css", selector: "#total" },
            match: "contains",
            value: "$9",
          },
        },
      ],
    );
    expect(spec).toContain("await expect(page).toHaveURL(/\\/orders\\/\\d+/);");
    expect(spec).toContain(
      'await expect.soft(page.getByRole("checkbox", { name: "Terms", exact: true })).not.toBeChecked();',
    );
    expect(spec).toContain('await expectCount(page.getByTestId("row"), { min: 2, max: 4 });');
    expect(spec).toContain(
      'await network.expectResponse({ method: "POST", url: "/api/**", status: 201 });',
    );
    expect(spec).toContain(
      'await expect(page.getByRole("list")).toMatchAriaSnapshot(`\n- listitem: One\n`);',
    );
    expect(spec).toContain('expect(await page.title()).toBe("Shop");');
    expect(spec).toContain('await expect(page.locator("#total")).toContainText("$9");');
  });

  it("never waits for a select's options or for the element it just acted on", async () => {
    const fp = (role: string, name: string) => ({
      primary: { kind: "role", role, name, exact: true },
      fallbacks: [],
      role,
      name,
      tag: "select",
      attributes: {},
      anchorText: "",
      framePath: [],
      box: null,
    });
    const wait = { settledMs: 10, waitedFor: { network: 0, dom: 10, busy: 0 } };
    const spec = await specFor(
      { "tests/t.test.md": "---\nname: t\n---\n1. Select UTC\n2. Fill it\n3. Click Go" },
      [
        {
          text: /^Select/,
          commands: [
            {
              action: {
                type: "select",
                target: { kind: "role", role: "combobox", name: "Zone", exact: true },
                option: "UTC",
              },
              fingerprint: fp("combobox", "Zone"),
              expectPost: { appeared: [{ role: "option", name: "UTC" }] },
              wait,
            },
          ],
        },
        {
          text: /^Fill/,
          commands: [
            {
              action: {
                type: "fill",
                target: { kind: "role", role: "textbox", name: "Card", exact: true },
                value: "4242",
              },
              fingerprint: fp("textbox", "Card"),
              expectPost: { appeared: [{ role: "textbox", name: "Card", text: "4242" }] },
              wait,
            },
          ],
        },
        {
          text: /^Click/,
          commands: [
            {
              action: {
                type: "click",
                target: { kind: "role", role: "button", name: "Go", exact: true },
              },
              fingerprint: fp("button", "Go"),
              expectPost: {},
              wait,
            },
          ],
        },
      ],
    );
    expect(spec).not.toContain('getByRole("option"');
    expect(spec).not.toMatch(/getByRole\("textbox", \{ name: "Card", exact: true \}\)\.first\(\)/);
  });

  it("runs a `matches` text check as a regex search, like the harness", async () => {
    const spec = await specFor(
      { "tests/t.test.md": "---\nname: t\n---\n1. Expect: A" },
      [],
      [
        {
          text: /^A$/,
          check: {
            type: "text",
            target: { kind: "css", selector: "tbody tr:visible", nth: 0 },
            match: "matches",
            value: "A-1002[\\s\\S]*\\$8\\.90",
          },
        },
      ],
    );
    expect(spec).toContain(
      'await expect(page.locator("tbody tr:visible").first()).toHaveText(/A-1002[\\s\\S]*\\$8\\.90/);',
    );
  });

  it("keeps a heading level, like the harness (the page heading is the h1)", async () => {
    const spec = await specFor(
      { "tests/t.test.md": "---\nname: t\n---\n1. Expect: A" },
      [],
      [
        {
          text: /^A$/,
          check: {
            type: "text",
            target: { kind: "role", role: "heading", level: 1 },
            match: "equals",
            value: "Dashboard",
          },
        },
      ],
    );
    expect(spec).toContain(
      'await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");',
    );
  });

  it("turns unknown, future and pending ops into notes, never assertions", async () => {
    const spec = await specFor(
      { "tests/t.test.md": file },
      [],
      [
        {
          text: /^B$/,
          soft: true,
          check: { type: "soft_judgment", question: "Tidy?", screenshot: "page" },
          generatedBy: "ai",
        },
        { text: /^C$/, check: { type: "hologram", depth: 3 } },
        { text: /^D$/, check: { type: "text", target: "not a locator" } },
      ],
    );
    expect(spec).toContain(`${CHECKED_ELSEWHERE}("Soft: B", "a model judges it");`);
    expect(spec).toContain(`${CHECKED_ELSEWHERE}("Expect: C", 'a "hologram" check');`);
    expect(spec).toContain(`${CHECKED_ELSEWHERE}("Expect: D", 'a "invalid:text" check');`);
    expect(spec).toContain(`${CHECKED_ELSEWHERE}("Expect: E", "not compiled to code yet");`);
    expect(spec).not.toMatch(/hologram.*toBe|Tidy/);
  });
});

describe("printing", () => {
  it("quotes like Biome: double quotes unless single quotes need fewer escapes", () => {
    expect(quote("plain")).toBe('"plain"');
    expect(quote('say "hi"')).toBe("'say \"hi\"'");
    expect(quote('it\'s "x"')).toBe("'it\\'s \"x\"'");
    expect(quote("a\nb")).toBe('"a\\nb"');
  });
});

// ── trace scrubbing (the generated reporter) ────────────────────────────────

interface ScrubModule {
  readZip(zip: Buffer): { entries: Array<{ name: string; data: Buffer }>; comment: string };
  writeZip(entries: Array<{ name: string; data: Buffer; time: number; date: number }>): Buffer;
  scrubTrace(
    file: string,
    secrets: Array<{ name: string; value: string }>,
    warn: (message: string) => void,
  ): "clean" | "scrubbed" | "deleted";
}

describe("trace scrubbing", async () => {
  const { files } = await generated();
  const dir = mkdtempSync(join(tmpdir(), "codegen-scrub-"));
  temps.push(dir);
  const reporterFile = join(dir, "reporter.ts");
  writeFileSync(reporterFile, files[`${brand.cliName}.reporter.ts`] ?? "");
  const scrub = (await import(reporterFile)) as ScrubModule;
  const secret = { name: "SHOP_PASSWORD", value: 'p@ss "word"/+&=1' };
  const entry = (name: string, text: string | Buffer) => ({
    name,
    data: Buffer.isBuffer(text) ? text : Buffer.from(text),
    time: 0,
    date: 33,
  });

  it("replaces every form of a secret in call params, network bodies and snapshots", () => {
    const file = join(dir, "trace.zip");
    const form = `email=ada%40example.com&password=${new URLSearchParams({ v: secret.value }).toString().slice(2)}`;
    writeFileSync(
      file,
      scrub.writeZip([
        entry("test.trace", JSON.stringify({ title: "Fill", params: { value: secret.value } })),
        entry(
          "0-trace.network",
          JSON.stringify({
            postData: { text: form },
            url: `/x?p=${encodeURIComponent(secret.value)}`,
          }),
        ),
        entry("0-trace.trace", JSON.stringify(["INPUT", { __playwright_value_: secret.value }])),
        entry(
          "resources/body.dat",
          Buffer.from(`{"b64":"${Buffer.from(`user:${secret.value}`).toString("base64")}"}`),
        ),
        entry(
          "resources/shot.jpeg",
          Buffer.concat([Buffer.from([0xff, 0xd8, 0]), Buffer.from(secret.value)]),
        ),
      ]),
    );
    const warnings: string[] = [];
    expect(scrub.scrubTrace(file, [secret], (m) => warnings.push(m))).toBe("scrubbed");
    expect(warnings).toEqual([]);
    const { entries } = scrub.readZip(readFileSync(file));
    const all = entries.map((e) => e.data.toString("latin1")).join("\n");
    for (const needle of [
      secret.value,
      JSON.stringify(secret.value).slice(1, -1),
      encodeURIComponent(secret.value),
      "p%40ss",
    ]) {
      expect(all).not.toContain(needle);
    }
    const body = JSON.parse(
      entries.find((e) => e.name === "resources/body.dat")?.data.toString() ?? "{}",
    );
    expect(Buffer.from(body.b64, "base64").toString()).toBe("user:[secret:SHOP_PASSWORD]");
    expect(all).toContain("[secret:SHOP_PASSWORD]");
    // Scrubbing again is a no-op.
    expect(scrub.scrubTrace(file, [secret], (m) => warnings.push(m))).toBe("clean");
  });

  it("deletes a trace it can't rewrite, with a warning, never keeping it", () => {
    const file = join(dir, "broken.zip");
    writeFileSync(file, `not a zip ${secret.value}`);
    const warnings: string[] = [];
    expect(scrub.scrubTrace(file, [secret], (m) => warnings.push(m))).toBe("deleted");
    expect(() => readFileSync(file)).toThrow();
    expect(warnings[0]).toContain(`Deleted trace ${file}`);
  });

  it("deletes traces when a secret is too short to find reliably", () => {
    const file = join(dir, "short.zip");
    writeFileSync(file, scrub.writeZip([entry("test.trace", "abc")]));
    expect(scrub.scrubTrace(file, [{ name: "PIN", value: "12" }], () => {})).toBe("deleted");
  });
});
