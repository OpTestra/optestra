import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { ENV_PREFIX } from "@optestra/config";
import { loadTest } from "@optestra/spec/node";
import { afterAll, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { fileState } from "./header.js";
import { generateMaestroFlow } from "./maestro.js";
import { type GenerateProjectResult, generateProject } from "./node/index.js";
import { readCodegenRecording } from "./recording.js";

// Maestro flows from Android recordings (MOB-6): the Android fixture's seven
// tests, from their committed recordings, against goldens committed next to them.

const ANDROID_DIR = fileURLToPath(new URL("../../../bench/fixtures/android/", import.meta.url));
const GOLDEN_DIR = join(ANDROID_DIR, "tests", brand.dataDirName);
const PLANTED = "planted-S3cret-value-9f2c";
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** The Android fixture project (config, tests, recordings) in a temp folder, with no flows yet. */
function composeAndroid(): string {
  const dir = mkdtempSync(join(tmpdir(), "codegen-android-"));
  temps.push(dir);
  // The `android` section belongs to @optestra/android (not a codegen dependency):
  // it says which emulator to use, nothing the flows depend on.
  const config = readFileSync(join(ANDROID_DIR, brand.configFileName), "utf8").replace(
    /\n# Tests run on Android[\s\S]*$/,
    "\n",
  );
  writeFileSync(join(dir, brand.configFileName), config);
  cpSync(join(ANDROID_DIR, "tests"), join(dir, "tests"), {
    recursive: true,
    filter: (source) => !source.endsWith(".maestro.yaml"),
  });
  return dir;
}

async function generated() {
  const dir = composeAndroid();
  const result = await generateProject({ projectDir: dir, env: { SHOP_PASSWORD: PLANTED } });
  const out = join(dir, "tests", brand.dataDirName);
  const files = Object.fromEntries(
    readdirSync(out)
      .filter((name) => name.endsWith(".maestro.yaml"))
      .sort()
      .map((name) => [name, readFileSync(join(out, name), "utf8")]),
  );
  return { dir, out, result, files };
}

const statuses = (result: GenerateProjectResult) =>
  Object.fromEntries(result.files.map((file) => [file.path.split("/").pop(), file.status]));

/** Every Maestro command the flows may use. */
const COMMANDS = new Set([
  "launchApp",
  "tapOn",
  "doubleTapOn",
  "longPressOn",
  "inputText",
  "eraseText",
  "pressKey",
  "back",
  "scroll",
  "scrollUntilVisible",
  "swipe",
  "openLink",
  "assertVisible",
  "assertNotVisible",
  "assertTrue",
  "evalScript",
  "extendedWaitUntil",
  "runFlow",
]);

describe("Maestro flows for Android tests (goldens)", async () => {
  const { result, files } = await generated();

  it("writes one flow per recorded test, and no Playwright files", () => {
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(Object.keys(files)).toEqual([
      "tests__check-updates.maestro.yaml",
      "tests__create-project.maestro.yaml",
      "tests__deep-link.maestro.yaml",
      "tests__scan-badge.maestro.yaml",
      "tests__sign-in.maestro.yaml",
      "tests__sign-out.maestro.yaml",
      "tests__wrong-password.maestro.yaml",
    ]);
    expect(result.files.every((f) => f.path.endsWith(".maestro.yaml"))).toBe(true);
    expect(result.files.every((f) => f.appId === "com.acme.shop")).toBe(true);
  });

  for (const [name, content] of Object.entries(files)) {
    it(`matches the golden ${name}`, async () => {
      await expect(content).toMatchFileSnapshot(join(GOLDEN_DIR, name));
    });
  }

  it("is valid YAML: a config document, then a list of known Maestro commands", () => {
    for (const [name, content] of Object.entries(files)) {
      const docs = parseAllDocuments(content);
      expect(
        docs.flatMap((d) => d.errors),
        name,
      ).toEqual([]);
      expect(docs).toHaveLength(2);
      const config = docs[0]?.toJS() as { appId: string; name: string };
      expect(config.appId, name).toBe("com.acme.shop");
      const commands = docs[1]?.toJS() as unknown[];
      expect(Array.isArray(commands), name).toBe(true);
      for (const command of commands) {
        const key = typeof command === "string" ? command : Object.keys(command as object)[0];
        expect(COMMANDS.has(key as string), `${name}: ${key}`).toBe(true);
      }
      expect(
        commands[commands.findIndex((c) => typeof c === "object" && c && "launchApp" in c)],
      ).toEqual({ launchApp: { clearState: true, permissions: { all: "unset" } } });
    }
  });

  it("never contains a secret value: the secret is a Maestro env var", () => {
    for (const [name, content] of Object.entries(files)) {
      expect(content, name).not.toContain(PLANTED);
      // Every test but the wrong-password one signs in with the secret.
      if (name === "tests__wrong-password.maestro.yaml") continue;
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro's own variable syntax.
      expect(content, name).toContain('- inputText: "${SHOP_PASSWORD}"');
      expect(content, name).toContain("-e SHOP_PASSWORD=…");
    }
  });

  it("keeps every English step as a comment above its commands", () => {
    const flow = files["tests__create-project.maestro.yaml"] ?? "";
    expect(flow).toContain("# 1. Use: flows/sign-in.test.md\n");
    expect(flow).toContain(
      '# 3. Type Q3 roadmap into "Project name"\n- tapOn:\n    id: "com.acme.shop:id/project_name"\n- eraseText\n- inputText: "Q3 roadmap"',
    );
    expect(flow).toContain(
      '# 6. Expect: the list shows "Q3 roadmap"\n- assertVisible:\n    text: ".*Q3 roadmap.*"',
    );
  });

  it("maps deep links, permissions, dialogs and scrolling", () => {
    expect(files["tests__deep-link.maestro.yaml"]).toContain(
      '- openLink: "acmeshop://projects/Mobile%20launch"',
    );
    expect(files["tests__scan-badge.maestro.yaml"]).toMatch(
      /# 5\. Allow camera access when Android asks\n- tapOn:\n {4}id: "\.\*:id\/\(permission_allow_foreground_only_button\|/,
    );
    expect(files["tests__sign-out.maestro.yaml"]).toContain(
      '# 3. Expect: a dialog asks "Sign out of Acme Shop?"\n- assertVisible:\n    text: "Sign out of Acme Shop\\\\?"',
    );
    expect(files["tests__check-updates.maestro.yaml"]).toContain(
      '- scrollUntilVisible:\n    element:\n      id: "com.acme.shop:id/check_updates_button"\n    direction: "DOWN"',
    );
  });

  it("waits for a tapped element to go away when the recording saw it go (VER-5)", () => {
    // The silent-tap trap: "Create project" does nothing, the form stays, and a later
    // text check could find "Q3 roadmap" in its field. The tap fails here instead.
    expect(files["tests__create-project.maestro.yaml"]).toContain(
      '# 4. Tap "Create project"\n- tapOn:\n    id: "com.acme.shop:id/create_project_button"\n- extendedWaitUntil:\n    notVisible:\n      id: "com.acme.shop:id/create_project_button"\n    timeout: 10000\n',
    );
    // A tap that leaves its element on screen (Refresh) has nothing to wait for.
    expect(files["tests__create-project.maestro.yaml"]).toContain(
      '# 7. Tap "Refresh"\n- tapOn:\n    id: "com.acme.shop:id/refresh_button"\n\n',
    );
  });

  it("runs setup requests from this machine, before the app starts", () => {
    const flow = files["tests__create-project.maestro.yaml"] ?? "";
    expect(flow).toContain(`env:\n  ${ENV_PREFIX}BASE_URL: "http://127.0.0.1:4180"`);
    expect(flow.indexOf("# setup: POST /__test/seed")).toBeLessThan(flow.indexOf("- launchApp:"));
    expect(flow).toContain('JSON.stringify({\\"projects\\":[\\"Website redesign\\"]})');
  });

  it("leaves out what Maestro can't check, with a comment, never an approximation", () => {
    const flow = files["tests__create-project.maestro.yaml"] ?? "";
    expect(flow).toContain(
      `# 5. Expect: a message says "Project created"\n# Checked by ${brand.productName} only: the message is a toast, and Maestro can't see toasts.\n`,
    );
    const created = result.files.find((f) => f.test === "tests/create-project.test.md");
    expect(created?.gaps).toEqual([
      `5. Expect: a message says "Project created": the message is a toast, and Maestro can't see toasts`,
    ]);
    // The same wording on the sign-in error is text on the screen, so it is checked.
    expect(files["tests__wrong-password.maestro.yaml"]).toContain(
      '- assertVisible:\n    text: ".*Email or password is incorrect\\\\..*"',
    );
  });
});

describe("regenerating Maestro flows", () => {
  it("leaves unchanged flows alone and refuses to overwrite one edited by hand", async () => {
    const { dir, out } = await generated();
    expect(
      new Set(Object.values(statuses(await generateProject({ projectDir: dir, env: {} })))),
    ).toEqual(new Set(["unchanged"]));
    const file = join(out, "tests__sign-in.maestro.yaml");
    const edited = readFileSync(file, "utf8").replace(
      '- inputText: "ada@example.com"',
      '- inputText: "grace@example.com"',
    );
    writeFileSync(file, edited);
    expect(fileState(edited)).toBe("edited");
    const refused = await generateProject({ projectDir: dir, env: {} });
    expect(statuses(refused)["tests__sign-in.maestro.yaml"]).toBe("edited");
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect(
      statuses(await generateProject({ projectDir: dir, env: {}, check: true }))[
        "tests__sign-in.maestro.yaml"
      ],
    ).toBe("edited");
    const forced = await generateProject({ projectDir: dir, env: {}, force: true });
    expect(statuses(forced)["tests__sign-in.maestro.yaml"]).toBe("overwritten");
    expect(fileState(readFileSync(file, "utf8"))).toBe("generated");
  });
});

describe("what Maestro can't express", () => {
  /** A test with the given steps, recorded from the fixture's own commands plus `extra`. */
  async function flowFor(
    lines: string,
    extra: {
      steps?: Record<string, unknown[]>;
      checks?: Record<string, unknown>;
      data?: string;
    },
  ) {
    const dir = composeAndroid();
    writeFileSync(
      join(dir, "tests", "gaps.test.md"),
      `---\nname: Gaps\n${extra.data ?? ""}---\n\n${lines}\n`,
    );
    const loaded = await loadTest(dir, "tests/gaps.test.md", undefined, { seed: "x" });
    if (!loaded) throw new Error("no test");
    const base = JSON.parse(
      readFileSync(
        join(dir, "tests", brand.dataDirName, "tests__create-project.steps.json"),
        "utf8",
      ),
    );
    const known = new Map<string, unknown>(
      base.steps.map((s: { text: string }) => [s.text, s] as const),
    );
    const steps = loaded.expanded.steps.flatMap((step) => {
      const commands = extra.steps?.[step.text];
      if (commands)
        return [
          {
            ...(known.get('Tap "Refresh"') as object),
            key: "0".repeat(16),
            textKey: step.textKey,
            text: step.text,
            commands,
          },
        ];
      const same = known.get(step.text) as { textKey: string } | undefined;
      return same ? [{ ...same, textKey: step.textKey }] : [];
    });
    const checks = loaded.expanded.steps.flatMap((step) => {
      const check = extra.checks?.[step.text];
      if (!check) return [];
      return [
        {
          key: "0".repeat(16),
          textKey: step.textKey,
          text: step.text,
          soft: false,
          check,
          generatedBy: "rules",
          recordedAt: base.updatedAt,
        },
      ];
    });
    const recording = readCodegenRecording({
      ...base,
      testId: "tests__gaps",
      testPath: "tests/gaps.test.md",
      steps,
      checks,
    });
    if (!recording.ok) throw new Error(recording.error);
    const flow = generateMaestroFlow(recording.recording, { expanded: loaded.expanded });
    if ("error" in flow) throw new Error(flow.error);
    return flow;
  }
  /** A recorded command; its element facts are the fixture's "Project name" field's (they name the app). */
  const fieldFacts = (
    JSON.parse(
      readFileSync(
        join(ANDROID_DIR, "tests", brand.dataDirName, "tests__create-project.steps.json"),
        "utf8",
      ),
    ) as { steps: Array<{ text: string; commands: Array<{ fingerprint: unknown }> }> }
  ).steps
    .find((s) => s.text.startsWith("Type Q3 roadmap"))
    ?.commands.at(-1)?.fingerprint;
  const command = (action: object) => ({
    action,
    fingerprint: fieldFacts,
    expectPost: {},
    wait: { settledMs: 0, waitedFor: { network: 0, dom: 0, busy: 0 } },
  });

  it("notes checks it can't make and carries on", async () => {
    const flow = await flowFor(
      '1. Tap "Refresh"\n2. Expect: the list has 2 items\n3. Expect: the screen is the projects screen\n4. Tap "Refresh"',
      {
        checks: {
          "the list has 2 items": {
            type: "count",
            target: { kind: "role", role: "listitem" },
            n: 2,
          },
          "the screen is the projects screen": {
            type: "url",
            match: "contains",
            value: "Projects",
          },
        },
      },
    );
    expect(flow.content).toContain(
      `# Checked by ${brand.productName} only: Maestro can't count elements.`,
    );
    expect(flow.content).toContain(
      `# Checked by ${brand.productName} only: Maestro can't check which screen (activity) is open.`,
    );
    expect(
      flow.content.match(/- tapOn:\n {4}id: "com\.acme\.shop:id\/refresh_button"/g),
    ).toHaveLength(2);
    expect(flow.gaps).toHaveLength(2);
  });

  it("stops at an action it can't do: what follows would run on the wrong screen", async () => {
    const flow = await flowFor('1. Rotate the phone to landscape\n2. Tap "Refresh"', {
      steps: {
        "Rotate the phone to landscape": [command({ type: "rotate", orientation: "landscape" })],
      },
    });
    expect(flow.content).toContain(
      `# 1. Rotate the phone to landscape\n# Checked by ${brand.productName} only: Maestro has no rotation command. Maestro stops here: the steps below need it.\n\n# 2. Tap "Refresh"\n`,
    );
    expect(flow.content).not.toContain("refresh_button");
    expect(flow.gaps).toEqual([
      "1. Rotate the phone to landscape: Maestro has no rotation command (the rest of the test is not exported)",
    ]);
  });

  it("never fixes a value made fresh on every run", async () => {
    const flow = await flowFor('1. Type {{data.email}} into "Project name"', {
      data: 'data:\n  email: "{{unique.email}}"\n',
      steps: {
        'Type {{data.email}} into "Project name"': [
          command({
            type: "fill",
            target: { kind: "role", role: "textbox", name: "Project name", exact: true },
            value: "{{unique.email}}",
          }),
        ],
      },
    });
    expect(flow.content).toContain("{{unique.email}} is made fresh on every run");
    expect(flow.content).not.toContain("inputText");
  });

  it("turns data and env vars into Maestro env vars with defaults", async () => {
    const flow = await flowFor('1. Type {{data.name}} into "Project name"', {
      data: "data:\n  name: Q3 roadmap\n",
      steps: {
        'Type {{data.name}} into "Project name"': [
          command({
            type: "fill",
            target: { kind: "role", role: "textbox", name: "Project name", exact: true },
            value: "{{data.name}}",
          }),
        ],
      },
    });
    expect(flow.content).toContain('env:\n  DATA_NAME: "Q3 roadmap"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Maestro's own variable syntax.
    expect(flow.content).toContain('- inputText: "${DATA_NAME}"');
  });
});
