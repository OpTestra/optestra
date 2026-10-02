import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { loadProject } from "@optestra/config/node";
import { afterAll, describe, expect, it } from "vitest";
import { type Asker, EXAMPLE_TEST, runInitCommand } from "./commands/init.js";

// `init` (ONB-1): never breaks an existing repo, idempotent, keys only in .env.

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
function temp(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-init-"));
  temps.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** Every file under `dir` with its bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(dir, path).split("\\").join("/")] = readFileSync(path, "base64");
  }
  return out;
}

const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
const init = (cwd: string, args: string[], input?: string) =>
  spawnSync(process.execPath, [bin, "init", ...args, "--no-doctor"], {
    cwd,
    env,
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });

describe("init", { timeout: 30_000 }, () => {
  it("sets up an empty folder: project file, example test, .env.example, .gitignore", () => {
    const dir = temp();
    const result = init(dir, ["--yes", "--name", "Demo", "--url", "http://127.0.0.1:4100"]);
    expect(result.status).toBe(0);
    expect(Object.keys(snapshot(dir)).sort()).toEqual(
      [".env.example", ".gitignore", brand.configFileName, "tests/example.test.md"].sort(),
    );
    const loaded = loadProject(dir, { env: {} });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.config.project.name).toBe("Demo");
    expect(loaded.environment?.settings.baseUrl).toBe("http://127.0.0.1:4100");
    expect(readFileSync(join(dir, "tests/example.test.md"), "utf8")).toBe(EXAMPLE_TEST);
    // Recordings and specs next to the tests are committed; local data and secrets are not.
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8").split("\n");
    for (const line of [
      ".env",
      ".env.*",
      "!.env.example",
      `${brand.dataDirName}/`,
      `!/tests/${brand.dataDirName}/`,
      `/tests/${brand.dataDirName}/authoring/`,
    ]) {
      expect(gitignore).toContain(line);
    }
    expect(gitignore.indexOf(`!/tests/${brand.dataDirName}/`)).toBeGreaterThan(
      gitignore.indexOf(`${brand.dataDirName}/`),
    );
    expect(result.stdout).toContain(`${brand.cliName} author tests/example.test.md`);
  });

  it("the example test is lint-clean", () => {
    const dir = temp();
    init(dir, ["--yes"]);
    const lint = spawnSync(process.execPath, [bin, "lint", "--strict"], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    expect(lint.stdout).toContain("No problems found in 1 file.");
    expect(lint.status).toBe(0);
  });

  it("changes nothing of an existing Playwright setup, and running it twice changes nothing", () => {
    const theirs = {
      "package.json": JSON.stringify({
        name: "acme-web",
        devDependencies: { next: "15.0.0", "@playwright/test": "1.50.0" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "playwright.config.ts":
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./tests" });\n',
      "tests/home.spec.ts":
        'import { test } from "@playwright/test";\ntest("home", async () => {});\n',
      "tests/helpers/login.ts": "export const user = 1;\n",
      ".gitignore": "node_modules\n.env\n",
    };
    const dir = temp(theirs);
    const before = snapshot(dir);
    const first = init(dir, ["--yes"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("Found: Next.js app; pnpm; Playwright (playwright.config.ts");
    const after = snapshot(dir);
    // Theirs: byte-identical, except .gitignore, which only grew at the end.
    for (const [name, bytes] of Object.entries(before)) {
      if (name === ".gitignore") continue;
      expect(after[name], name).toBe(bytes);
    }
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gitignore.startsWith(theirs[".gitignore"])).toBe(true);
    expect(gitignore.match(/^\.env$/gm)?.length).toBe(1);
    // Their tests/ folder is left to them: the .test.md files get their own folder.
    const ours = brand.cliName;
    expect(existsSync(join(dir, ours, "example.test.md"))).toBe(true);
    expect(loadProject(dir, { env: {} }).config.tests?.dir).toBe(ours);
    expect(gitignore).toContain(`!/${ours}/${brand.dataDirName}/`);
    // The default base URL comes from the framework.
    expect(loadProject(dir, { env: {} }).environment?.settings.baseUrl).toBe(
      "http://localhost:3000",
    );

    const second = init(dir, ["--yes"]);
    expect(second.status).toBe(0);
    expect(snapshot(dir)).toEqual(after);
    expect(second.stdout).toContain("kept     .gitignore");
    expect(second.stdout).toContain(`kept     ${brand.configFileName}`);
  });

  it("says how to keep an overlapping Playwright config off the generated specs, without editing it", () => {
    const config =
      'import { defineConfig } from "@playwright/test";\nexport default defineConfig({});\n';
    const dir = temp({ "playwright.config.ts": config });
    const result = init(dir, ["--yes"]);
    expect(result.stdout).toContain(`testIgnore: ["**/${brand.dataDirName}/**"]`);
    expect(readFileSync(join(dir, "playwright.config.ts"), "utf8")).toBe(config);
  });

  it("takes every answer from flags (CI) and rejects bad ones", () => {
    const dir = temp();
    const ok = init(dir, [
      "--yes",
      "--name",
      "CI Project",
      "--url",
      "https://staging.example.com",
      "--target",
      "web",
      "--ai",
      "codex",
    ]);
    expect(ok.status).toBe(0);
    const loaded = loadProject(dir, { env: {} });
    expect(loaded.config.project.name).toBe("CI Project");
    expect(loaded.environment?.settings.allowedDomains).toEqual(["staging.example.com"]);
    expect(loaded.config.models.roles.planner).toEqual([{ provider: "codex", model: "default" }]);
    expect(existsSync(join(dir, ".env"))).toBe(false);

    expect(init(temp(), ["--yes", "--ai", "gemini-cli"]).status).toBe(2);
    expect(init(temp(), ["--yes", "--url", "localhost:3000"]).status).toBe(2);
    expect(init(temp(), ["--yes", "--target", "ios"]).status).toBe(2);
  });

  it("writes an API key to .env only (0600), never to the project file", () => {
    const key = "sk-ant-test-0123456789abcdef";
    const dir = temp();
    const result = init(dir, ["--yes", "--ai", "anthropic", "--key-stdin"], `${key}\n`);
    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`ANTHROPIC_API_KEY=${key}\n`);
    if (process.platform !== "win32") expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".env.example"), "utf8")).toContain("ANTHROPIC_API_KEY=\n");
    for (const [name, bytes] of Object.entries(snapshot(dir))) {
      if (name === ".env") continue;
      expect(Buffer.from(bytes, "base64").toString("utf8"), name).not.toContain(key);
    }
    expect(result.stdout).not.toContain(key);
    // An existing .env keeps its lines; a key already there is not replaced.
    const again = init(dir, ["--yes", "--ai", "anthropic", "--key-stdin"], "sk-other\n");
    expect(again.stdout).toContain("ANTHROPIC_API_KEY is already set there");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`ANTHROPIC_API_KEY=${key}\n`);
  });

  it("asks when interactive: OpenRouter gets a provider entry, its key goes to .env", async () => {
    const dir = temp({ ".env": "OTHER=1" });
    const answers: string[] = [];
    const asker: Asker = {
      text: async (question, fallback) => {
        answers.push(question);
        return question.startsWith("Project name") ? "Asked" : fallback;
      },
      choose: async (_question, options) => options.indexOf("OpenRouter API key"),
      secret: async () => "sk-or-secret-value",
    };
    let out = "";
    const code = await runInitCommand(
      undefined,
      { doctor: false },
      { cwd: dir, env: {}, stdout: (text) => (out += text), ask: asker },
    );
    expect(code).toBe(0);
    expect(answers[0]).toBe("Project name");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
      "OTHER=1\nOPENROUTER_API_KEY=sk-or-secret-value\n",
    );
    const text = readFileSync(join(dir, brand.configFileName), "utf8");
    expect(text).not.toContain("sk-or-secret-value");
    const loaded = loadProject(dir, { env: {} });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.config.project.name).toBe("Asked");
    // The named provider knows its base URL and key name (PROV-0).
    expect(loaded.config.models.providers.openrouter).toMatchObject({ kind: "openrouter" });
    expect(loaded.config.models.roles.planner[0]).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
    });
    expect(out).toContain("stored as OPENROUTER_API_KEY in .env");
  });

  it("Ollama Cloud: needs a model named (none has passed the model eval to be a default)", async () => {
    const dir = temp({});
    let out = "";
    const io = { cwd: dir, env: {}, stdout: (text: string) => (out += text) };
    expect(
      await runInitCommand(undefined, { yes: true, ai: "ollama-cloud", doctor: false }, io),
    ).toBe(2);
    expect(out).toContain("--ai ollama-cloud needs --ai-model");
    const code = await runInitCommand(
      undefined,
      { yes: true, ai: "ollama-cloud", aiModel: "kimi-k3", doctor: false },
      io,
    );
    expect(code).toBe(0);
    const loaded = loadProject(dir, { env: {} });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.config.models.providers["ollama-cloud"]).toMatchObject({ kind: "ollama-cloud" });
    expect(loaded.config.models.roles.fixer[0]).toEqual({
      provider: "ollama-cloud",
      model: "kimi-k3",
    });
  });
});

describe("init: agent instructions (AGT-2) and starter tests (ONB-2)", () => {
  const quiet = (dir: string, extra: Partial<Parameters<typeof runInitCommand>[2]> = {}) => {
    let out = "";
    return {
      io: { cwd: dir, env: {}, stdout: (text: string) => (out += text), ...extra },
      out: () => out,
    };
  };

  it("--agents appends the snippet to AGENTS.md and CLAUDE.md once, keeping their text", async () => {
    const dir = temp({ "AGENTS.md": "# Agents\n\nUse pnpm.\n", "CLAUDE.md": "Be brief." });
    const { io } = quiet(dir);
    expect(await runInitCommand(undefined, { yes: true, doctor: false, agents: true }, io)).toBe(0);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# Agents\n\nUse pnpm.\n\n")).toBe(true);
    expect(agents).toContain("Never edit an `Expect:` or `Soft:` line to make a failing test pass");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8").startsWith("Be brief.\n\n")).toBe(true);
    // Twice changes nothing.
    await runInitCommand(undefined, { yes: true, doctor: false, agents: true }, quiet(dir).io);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(agents);
  });

  it("asks first when interactive; no leaves the files alone; --yes never asks or writes", async () => {
    const dir = temp({ "CLAUDE.md": "Be brief.\n" });
    const questions: string[] = [];
    const asker: Asker = {
      text: async (_q, fallback) => fallback,
      choose: async (_q, _o, fallback) => fallback,
      secret: async () => "",
      confirm: async (question) => {
        questions.push(question);
        return false;
      },
    };
    await runInitCommand(undefined, { doctor: false, ai: "later" }, quiet(dir, { ask: asker }).io);
    expect(questions).toEqual([
      "Add to CLAUDE.md the instructions for coding agents (how to run tests; never edit expectations to make them pass)?",
    ]);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("Be brief.\n");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);

    const yes = { ...asker, confirm: async () => true };
    await runInitCommand(undefined, { doctor: false, ai: "later" }, quiet(dir, { ask: yes }).io);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("## End-to-end tests");

    const plain = temp();
    await runInitCommand(undefined, { yes: true, doctor: false }, quiet(plain).io);
    expect(existsSync(join(plain, "AGENTS.md"))).toBe(false);
  });

  it("--suggest shows the starter drafts and saves only the ones you say yes to", async () => {
    const dir = temp();
    const draft = (name: string, path: string, lintClean = true) => ({
      status: "drafted" as const,
      name,
      path,
      text: `---\nname: ${name}\nstart: /\n---\n\n1. Expect: the page heading is "Acme Shop"\n`,
      lintClean,
      notes: [],
    });
    const suggest = (async () => ({
      proposals: [],
      drafts: [
        draft("The home page loads", "tests/the-home-page-loads.test.md"),
        draft("Returning user can log in", "tests/returning-user-can-log-in.test.md"),
        draft("Vague", "tests/vague.test.md", false),
      ],
      notes: [],
      modelCalls: [{}, {}],
      environment: "local",
    })) as never;
    const answers = [true, false];
    const asker: Asker = {
      text: async (_q, fallback) => fallback,
      choose: async (_q, _o, fallback) => fallback,
      secret: async () => "",
      confirm: async (question) =>
        question.includes("Save ") ? (answers.shift() ?? false) : false,
    };
    const { io, out } = quiet(dir, { ask: asker, suggest });
    await runInitCommand(undefined, { doctor: false, ai: "later", suggest: true }, io);
    expect(existsSync(join(dir, "tests/the-home-page-loads.test.md"))).toBe(true);
    expect(existsSync(join(dir, "tests/returning-user-can-log-in.test.md"))).toBe(false);
    expect(existsSync(join(dir, "tests/vague.test.md"))).toBe(false);
    expect(out()).toContain("(2 AI calls)");
    expect(out()).toContain("Not offered for saving");

    // Without a terminal nothing is saved: the drafts are only shown.
    const ci = temp();
    const { io: ciIo, out: ciOut } = quiet(ci, { suggest });
    await runInitCommand(undefined, { yes: true, doctor: false, suggest: true }, ciIo);
    expect(existsSync(join(ci, "tests/the-home-page-loads.test.md"))).toBe(false);
    expect(ciOut()).toContain("Not saved (review first)");
  });
});
