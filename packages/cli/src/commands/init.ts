import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { brand } from "@optestra/brand";
import type { ConfigPatch } from "@optestra/config";
import {
  createProject,
  loadProject,
  parseDotenv,
  projectFile,
  saveProject,
} from "@optestra/config/node";
// Registers the sections the project file may use (models, tests, decisions, auth).
import "../sections.js";
import type { Command } from "commander";
import type { CommandIo } from "./config.js";
import type { DoctorProbes } from "./doctor.js";
import {
  findPlaywrightSetup,
  type PlaywrightSetup,
  playwrightOverlap,
} from "./playwright-setup.js";

// `init [dir]` (ONB-1): sets up a project in an existing repository without
// breaking anything. It never overwrites a file, never touches an existing
// Playwright config or spec, only appends to .gitignore, and writes keys only
// to .env (git-ignored), never to the project file. Running it twice changes
// nothing the second time.

export const AI_CHOICES = [
  "claude-code",
  "codex",
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "ollama-cloud",
  "openai-compatible",
  "later",
] as const;
export type AiChoice = (typeof AI_CHOICES)[number];

const AI_LABELS: Record<AiChoice, string> = {
  "claude-code": "Use my Claude subscription (Claude Code)",
  codex: "Use my ChatGPT subscription (Codex)",
  anthropic: "Anthropic API key",
  openai: "OpenAI API key",
  google: "Google Gemini API key",
  openrouter: "OpenRouter API key",
  "ollama-cloud": "Ollama Cloud API key",
  "openai-compatible": "Another OpenAI-compatible API (base URL + key)",
  later: "Set up later",
};

/** The key each API-key choice stores in .env. */
const KEY_NAMES: Partial<Record<AiChoice, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "ollama-cloud": "OLLAMA_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
};

const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-5.5";
/** The Ollama Cloud model that passed the model eval (EVAL-1, bench/results/2026-10-02-open-models.json). */
const DEFAULT_OLLAMA_MODEL = "deepseek-v4.1-flash";

export interface InitCommandOptions {
  yes?: boolean;
  name?: string;
  url?: string;
  target?: string;
  app?: string;
  ai?: string;
  aiBaseUrl?: string;
  aiModel?: string;
  keyStdin?: boolean;
  /** `--no-doctor` sets this to false. */
  doctor?: boolean;
  /** Explore the app and propose 3 starter tests (ONB-2); each is saved only when you say so. */
  suggest?: boolean;
  /** Append the coding-agent instructions to AGENTS.md / CLAUDE.md without asking (AGT-2). */
  agents?: boolean;
}

/** How init asks questions. The terminal one uses node:readline; tests pass answers. */
export interface Asker {
  text(question: string, fallback: string): Promise<string>;
  choose(question: string, options: readonly string[], fallback: number): Promise<number>;
  /** Input is not echoed. */
  secret(question: string): Promise<string>;
  /** A yes/no question; the default is no. */
  confirm?(question: string): Promise<boolean>;
}

export interface InitIo extends CommandIo {
  /** Present when init may ask (a terminal, no --yes). */
  ask?: Asker | undefined;
  /** For --key-stdin. */
  readStdin?: () => Promise<string>;
  /** Test hook for the closing doctor run. */
  probes?: DoctorProbes;
  /** Test hook for --suggest: proposes drafts without a browser or AI. */
  suggest?: typeof import("@optestra/core/node").suggestStarterTests;
}

// ── detecting the repository ──────────────────────────────────────────────────

export interface RepoInfo {
  name: string;
  packageManager: "pnpm" | "yarn" | "bun" | "npm" | null;
  framework: string | null;
  baseUrl: string;
  playwright: PlaywrightSetup | undefined;
}

const FRAMEWORKS: Array<{ dep: string; label: string; url: string }> = [
  { dep: "next", label: "Next.js", url: "http://localhost:3000" },
  { dep: "nuxt", label: "Nuxt", url: "http://localhost:3000" },
  { dep: "@remix-run/dev", label: "Remix", url: "http://localhost:3000" },
  { dep: "@sveltejs/kit", label: "SvelteKit", url: "http://localhost:5173" },
  { dep: "astro", label: "Astro", url: "http://localhost:4321" },
  { dep: "@angular/core", label: "Angular", url: "http://localhost:4200" },
  { dep: "react-scripts", label: "Create React App", url: "http://localhost:3000" },
  { dep: "vite", label: "Vite", url: "http://localhost:5173" },
];

function readPackageJson(dir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** What's in the repository: its package manager, app framework and Playwright setup. */
export function detectRepo(dir: string): RepoInfo {
  const pkg = readPackageJson(dir);
  const deps = {
    ...((pkg?.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg?.devDependencies as Record<string, string> | undefined) ?? {}),
  };
  const lockfiles: Array<[string, RepoInfo["packageManager"]]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ];
  const packageManager =
    lockfiles.find(([file]) => existsSync(join(dir, file)))?.[1] ?? (pkg ? "npm" : null);
  const framework = FRAMEWORKS.find((f) => f.dep in deps);
  const name = typeof pkg?.name === "string" && pkg.name ? pkg.name : basename(resolve(dir));
  return {
    name,
    packageManager,
    framework: framework?.label ?? null,
    baseUrl: framework?.url ?? "http://localhost:3000",
    playwright: findPlaywrightSetup(dir),
  };
}

/** `tests`, unless that folder already holds someone else's files (then the CLI name). */
function chooseTestsDir(dir: string): string {
  const folder = join(dir, "tests");
  if (!existsSync(folder)) return "tests";
  const theirs = readdirSync(folder).some(
    (name) => !name.startsWith(".") && !name.endsWith(".test.md") && name !== "flows",
  );
  return theirs && !existsSync(join(dir, brand.cliName)) ? brand.cliName : "tests";
}

// ── writing ───────────────────────────────────────────────────────────────────

/** A real, lint-clean first test: the home page of the base URL. */
export const EXAMPLE_TEST = `---
name: The home page loads
tags: [smoke]
start: /
---

1. Expect: the page shows a heading
`;

function modelsPatch(choice: AiChoice, baseUrl?: string, model?: string): ConfigPatch | undefined {
  switch (choice) {
    case "claude-code":
      return {
        models: {
          roles: {
            planner: [{ provider: "claude-code", model: "claude-sonnet-5-5" }],
            fixer: [{ provider: "claude-code", model: "claude-sonnet-5-5" }],
          },
        },
      } as ConfigPatch;
    case "codex":
      return {
        models: {
          roles: {
            planner: [{ provider: "codex", model: "default" }],
            fixer: [{ provider: "codex", model: "default" }],
          },
        },
      } as ConfigPatch;
    // Named providers know their base URL and key name; only the model is chosen.
    case "openrouter":
    case "ollama-cloud": {
      const entry = {
        provider: choice,
        model:
          model ?? (choice === "ollama-cloud" ? DEFAULT_OLLAMA_MODEL : DEFAULT_OPENROUTER_MODEL),
      };
      return {
        models: {
          providers: { [choice]: { kind: choice } },
          roles: { planner: [entry], fixer: [entry] },
        },
      } as ConfigPatch;
    }
    case "openai-compatible": {
      const entry = { provider: "compatible", model: model ?? DEFAULT_OPENROUTER_MODEL };
      return {
        models: {
          providers: {
            compatible: { kind: "openai-compatible", baseUrl, keySecret: KEY_NAMES[choice] },
          },
          roles: { planner: [entry], fixer: [entry] },
        },
      } as ConfigPatch;
    }
    default:
      return undefined;
  }
}

/** Appends NAME=value to .env (created 0600) unless NAME is already there. */
function writeKey(dir: string, name: string, value: string): "created" | "updated" | "skipped" {
  const file = join(dir, ".env");
  const line = `${name}=${/[\s#"'\\]/.test(value) ? JSON.stringify(value) : value}\n`;
  if (!existsSync(file)) {
    writeFileSync(file, line, { mode: 0o600, flag: "wx" });
    return "created";
  }
  const current = readFileSync(file, "utf8");
  if (name in parseDotenv(current, file).values) return "skipped";
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${separator}${line}`);
  if ((statSync(file).mode & 0o077) !== 0) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // Not ours to fix on every file system (Windows).
    }
  }
  return "updated";
}

// ── the terminal asker ────────────────────────────────────────────────────────

/** Questions on the terminal, with node:readline. Secrets are not echoed. */
export function terminalAsker(): Asker {
  const ask = (question: string, hidden = false) =>
    new Promise<string>((done) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      let muted = false;
      if (hidden) {
        // Keys are typed without echo: once the question is shown, nothing is written back.
        const internals = rl as unknown as { _writeToOutput: (text: string) => void };
        internals._writeToOutput = (text: string) => {
          if (!muted) process.stdout.write(text);
        };
      }
      rl.question(question, (answer) => {
        if (hidden) process.stdout.write("\n");
        rl.close();
        done(answer.trim());
      });
      muted = hidden;
    });
  return {
    async text(question, fallback) {
      return (await ask(`${question}${fallback ? ` (${fallback})` : ""}: `)) || fallback;
    },
    async choose(question, options, fallback) {
      process.stdout.write(`${question}\n`);
      options.forEach((option, i) => {
        process.stdout.write(`  ${i + 1}) ${option}${i === fallback ? "  (default)" : ""}\n`);
      });
      for (;;) {
        const answer = await ask(`Choose 1-${options.length}: `);
        if (answer === "") return fallback;
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      }
    },
    secret(question) {
      return ask(`${question}: `, true);
    },
    async confirm(question) {
      return /^y(es)?$/i.test(await ask(`${question} [y/N] `));
    },
  };
}

const confirm = (ask: Asker, question: string) =>
  ask.confirm ? ask.confirm(question) : ask.choose(question, ["No", "Yes"], 0).then((i) => i === 1);

/** The files agent instructions can go in: the ones there, else a new AGENTS.md. */
const AGENT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * AGT-2: offers to append the coding-agent instructions to AGENTS.md / CLAUDE.md.
 * Asked first (or --agents); append only; never twice.
 */
async function offerAgentInstructions(
  dir: string,
  options: InitCommandOptions,
  ask: Asker | undefined,
  io: InitIo,
): Promise<void> {
  if (!options.agents && !ask) return;
  const { appendAgentsSnippet } = await import("@optestra/mcp/instructions");
  const present = AGENT_FILES.filter((name) => existsSync(join(dir, name)));
  for (const name of present.length ? present : (["AGENTS.md"] as const)) {
    const file = join(dir, name);
    const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const next = appendAgentsSnippet(existing);
    if (next === null) {
      io.stdout(`  kept     ${name} (already has the ${brand.productName} instructions)\n`);
      continue;
    }
    const yes =
      options.agents ||
      (ask !== undefined &&
        (await confirm(
          ask,
          `${existing === undefined ? "Create" : "Add to"} ${name} the instructions for coding agents (how to run tests; never edit expectations to make them pass)?`,
        )));
    if (!yes) continue;
    if (existing === undefined) writeFileSync(file, next, { flag: "wx" });
    else appendFileSync(file, next.slice(existing.length));
    io.stdout(
      `  ${existing === undefined ? "created " : "updated "} ${name} (instructions for coding agents)\n`,
    );
  }
}

/** ONB-2: explores the app and proposes starter tests; each is saved only on a yes. */
async function suggestStarters(dir: string, ask: Asker | undefined, io: InitIo): Promise<void> {
  io.stdout(`\nExploring the app for starter tests…\n`);
  const core = await import("@optestra/core/node");
  const { DraftSetupError } = core;
  const suggestStarterTests = io.suggest ?? core.suggestStarterTests;
  let suggestions: Awaited<ReturnType<typeof suggestStarterTests>>;
  try {
    suggestions = await suggestStarterTests(undefined, { project: dir, env: io.env });
  } catch (error) {
    const fix = error instanceof DraftSetupError ? ` Fix: ${error.fix}` : "";
    io.stdout(
      `  No starter tests: ${error instanceof Error ? error.message : String(error)}${fix}\n`,
    );
    return;
  }
  for (const note of suggestions.notes) io.stdout(`  ${note}\n`);
  const calls = suggestions.modelCalls.length;
  if (calls) io.stdout(`  (${calls} AI call${calls === 1 ? "" : "s"})\n`);
  for (const draft of suggestions.drafts) {
    io.stdout(`\n  ${draft.name} → ${draft.path}${draft.lintClean ? "" : " (lint problems)"}\n`);
    io.stdout(`${draft.text.replace(/^(?=.)/gm, "      ")}`);
    for (const note of draft.notes) io.stdout(`    - ${note}\n`);
    const file = join(dir, ...draft.path.split("/"));
    if (!draft.lintClean || draft.status === "impossible" || draft.status === "stopped") {
      io.stdout("    Not offered for saving: fix it first, or draft it again with `new`.\n");
      continue;
    }
    if (!ask) {
      io.stdout(
        "    Not saved (review first): run init --suggest in a terminal, or save it with `new --accept`.\n",
      );
      continue;
    }
    if (existsSync(file)) {
      io.stdout(`    ${draft.path} already exists: not saved.\n`);
      continue;
    }
    if (await confirm(ask, `    Save ${draft.path}?`)) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, draft.text, { flag: "wx" });
      io.stdout(`    created  ${draft.path}\n`);
    }
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// ── the command ───────────────────────────────────────────────────────────────

const isAiChoice = (value: string): value is AiChoice =>
  (AI_CHOICES as readonly string[]).includes(value);

async function defaultAiChoice(env: CommandIo["env"]): Promise<number> {
  const { findBinary, signInStatus } = await import("@optestra/models");
  for (const kind of ["claude-code", "codex"] as const) {
    const found = findBinary(kind, undefined, env);
    if (found.ok && (await signInStatus(kind, found.binary, env)).signedIn) {
      return AI_CHOICES.indexOf(kind);
    }
  }
  return AI_CHOICES.indexOf("later");
}

/** Exit 0 set up (whatever doctor then says), 2 bad flags or a folder that can't be used. */
export async function runInitCommand(
  dirArg: string | undefined,
  options: InitCommandOptions,
  io: InitIo,
): Promise<number> {
  const dir = resolve(io.cwd, dirArg ?? ".");
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    io.stdout(`${dir} is a file. Pass a folder.\n`);
    return 2;
  }
  const target = options.target ?? "web";
  if (target !== "web" && target !== "android") {
    io.stdout(`Unknown target "${target}". Use --target web or --target android.\n`);
    return 2;
  }
  if (options.ai !== undefined && !isAiChoice(options.ai)) {
    io.stdout(`Unknown AI setup "${options.ai}". Use one of: ${AI_CHOICES.join(", ")}.\n`);
    return 2;
  }
  if (options.url !== undefined) {
    try {
      const url = new URL(options.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      io.stdout(`"${options.url}" is not an http(s) URL.\n`);
      return 2;
    }
  }
  mkdirSync(dir, { recursive: true });
  const repo = detectRepo(dir);
  const ask = options.yes ? undefined : io.ask;
  const out: string[] = [];

  // What's already here.
  const found = [
    repo.framework ? `${repo.framework} app` : undefined,
    repo.packageManager ? `${repo.packageManager}` : undefined,
    repo.playwright
      ? `Playwright (${repo.playwright.configFile}, tests in ${repo.playwright.testDir}): left as it is`
      : undefined,
  ].filter(Boolean);
  if (found.length) io.stdout(`Found: ${found.join("; ")}.\n\n`);

  const existing = existsSync(projectFile(dir));
  if (existing) io.stdout(`${brand.configFileName} already exists: keeping it as it is.\n\n`);

  // The answers.
  const name =
    options.name ?? (ask && !existing ? await ask.text("Project name", repo.name) : repo.name);
  let baseUrl = options.url ?? repo.baseUrl;
  if (!options.url && ask && !existing && target === "web") {
    for (;;) {
      baseUrl = await ask.text("Base URL of the app (where it runs while you test)", repo.baseUrl);
      try {
        if (/^https?:$/.test(new URL(baseUrl).protocol)) break;
      } catch {}
      io.stdout("  That isn't an http(s) URL.\n");
    }
  }
  let ai: AiChoice;
  if (options.ai !== undefined) ai = options.ai as AiChoice;
  else if (ask && !existing) {
    const labels = AI_CHOICES.map((choice) => AI_LABELS[choice]);
    ai = AI_CHOICES[await ask.choose("AI setup", labels, await defaultAiChoice(io.env))] ?? "later";
  } else ai = "later";

  let aiBaseUrl = options.aiBaseUrl;
  let aiModel = options.aiModel;
  if (ai === "openai-compatible" && !aiBaseUrl) {
    if (!ask) {
      io.stdout("--ai openai-compatible needs --ai-base-url (and --ai-model).\n");
      return 2;
    }
    aiBaseUrl = await ask.text("API base URL (e.g. http://localhost:11434/v1)", "");
  }
  if (ai === "ollama-cloud" && !aiModel) {
    aiModel = ask
      ? await ask.text("Ollama Cloud model (see ollama.com/search?c=cloud)", DEFAULT_OLLAMA_MODEL)
      : DEFAULT_OLLAMA_MODEL;
  }
  if ((ai === "openai-compatible" || ai === "openrouter") && !aiModel) {
    aiModel = ask
      ? await ask.text("Model", ai === "openrouter" ? DEFAULT_OPENROUTER_MODEL : "")
      : DEFAULT_OPENROUTER_MODEL;
  }

  const keyName = KEY_NAMES[ai];
  let key: string | undefined;
  if (keyName) {
    if (options.keyStdin) key = (await (io.readStdin ?? readAllStdin)()).trim() || undefined;
    else if (ask && !io.env[keyName]) {
      key = (await ask.secret(`${keyName} (saved to .env only; Enter to skip)`)) || undefined;
    }
  }

  // Writing.
  const testsDir = existing
    ? (loadProject(dir, { env: io.env }).config.tests?.dir ?? "tests")
    : chooseTestsDir(dir);
  const created = createProject(dir, {
    name,
    target,
    ...(target === "web" ? { baseUrl } : {}),
    ...(options.app ? { app: options.app } : {}),
    testsDir,
    ...(keyName ? { envNames: [keyName] } : {}),
  });
  const patch = modelsPatch(ai, aiBaseUrl, aiModel);
  if (patch && created.created.includes(brand.configFileName)) {
    const saved = saveProject(dir, patch);
    if (!saved.ok) {
      for (const d of saved.diagnostics)
        out.push(`  could not save the AI setup: ${d.message} ${d.fix}`);
    } else {
      // Our own new file: give the section a comment like the rest of the template.
      const file = projectFile(dir);
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          /^models:$/m,
          "\n# The AI models each role uses. Keys go in .env, never in this file.\nmodels:",
        ),
      );
    }
  }

  const exampleRel = `${testsDir}/example.test.md`;
  let example: "created" | "skipped" | "none" = "none";
  if (target === "web") {
    mkdirSync(join(dir, testsDir), { recursive: true });
    const examplePath = join(dir, exampleRel);
    if (existsSync(examplePath)) example = "skipped";
    else {
      writeFileSync(examplePath, EXAMPLE_TEST, { flag: "wx" });
      example = "created";
    }
  }

  let keyResult: "created" | "updated" | "skipped" | undefined;
  if (keyName && key) keyResult = writeKey(dir, keyName, key);

  // Report.
  const rows: Array<[string, string]> = [
    ...created.created.map((file): [string, string] => ["created", file]),
    ...(example === "created" ? [["created", exampleRel] as [string, string]] : []),
    ...created.updated.map((file): [string, string] => ["updated", file]),
    ...(keyResult === "created" ? [["created", `.env (${keyName})`] as [string, string]] : []),
    ...(keyResult === "updated"
      ? [["updated", `.env (added ${keyName})`] as [string, string]]
      : []),
    ...created.skipped.map((file): [string, string] => ["kept", file]),
    ...(example === "skipped" ? [["kept", exampleRel] as [string, string]] : []),
    ...(keyResult === "skipped"
      ? [["kept", `.env (${keyName} is already set there)`] as [string, string]]
      : []),
  ];
  for (const [status, file] of rows) io.stdout(`  ${status.padEnd(8)} ${file}\n`);
  for (const line of out) io.stdout(`${line}\n`);

  const notes: string[] = [];
  if (ai === "claude-code" || ai === "codex") {
    notes.push(
      `AI: your ${ai === "claude-code" ? "Claude subscription through Claude Code" : "ChatGPT subscription through Codex"}. Sign in with \`${ai === "claude-code" ? "claude auth login" : "codex login"}\` if you haven't; \`${brand.cliName} login\` shows what's ready.`,
    );
  } else if (keyName) {
    notes.push(
      key
        ? `AI: ${AI_LABELS[ai]}, stored as ${keyName} in .env (git-ignored).`
        : io.env[keyName]
          ? `AI: ${AI_LABELS[ai]}, read from the ${keyName} environment variable.`
          : `AI: add ${keyName}=<your key> to .env (git-ignored) before authoring.`,
    );
  } else {
    notes.push(
      `AI: not set up yet. Sign in to Claude Code (\`claude auth login\`) or Codex (\`codex login\`), or put an API key in .env. \`${brand.cliName} login\` explains.`,
    );
  }
  const overlap = playwrightOverlap(dir, testsDir);
  if (overlap && !overlap.ignored) {
    notes.push(
      `Your Playwright setup: nothing was changed. Once tests are recorded, ${overlap.configFile} would also pick up the specs generated in ${testsDir}/${brand.dataDirName}/. ${overlap.fix}`,
    );
  }
  io.stdout(`\n${notes.join("\n")}\n`);

  await offerAgentInstructions(dir, options, ask, io);

  if (options.doctor !== false) {
    const { formatDoctorReport, runDoctor } = await import("./doctor.js");
    const report = await runDoctor({
      dir,
      env: io.env,
      ...(io.probes ? { probes: io.probes } : {}),
    });
    const { defaultRedactor } = await import("@optestra/config/node");
    io.stdout(`\n${defaultRedactor.redact(formatDoctorReport(report))}\n`);
  }

  if (options.suggest) {
    if (target === "web") await suggestStarters(dir, ask, io);
    else io.stdout("\n--suggest drafts web tests only for now.\n");
  }

  io.stdout(
    target === "web"
      ? `\nNext: start your app, then record the example test:\n  ${brand.cliName} author ${exampleRel}\n`
      : `\nNext: write a test in ${testsDir}/, then record it with \`${brand.cliName} author <file>\`.\n`,
  );
  return 0;
}

export function registerInitCommand(program: Command, io: () => CommandIo): void {
  program
    .command("init")
    .description(
      "set up a project in this repository: project file, an example test, .env.example and .gitignore lines (never overwrites a file)",
    )
    .argument("[dir]", "the repository folder (default: the current folder)")
    .option("-y, --yes", "don't ask: use the flags and the detected defaults (for CI)")
    .option("--name <name>", "project name (default: package.json name or the folder name)")
    .option(
      "--url <url>",
      "base URL of the app (default: from the framework, e.g. http://localhost:3000)",
    )
    .option("--target <target>", "web (default) or android")
    .option("--app <path>", "android: the APK path")
    .option("--ai <setup>", `AI setup: ${AI_CHOICES.join(", ")}`)
    .option("--ai-base-url <url>", "for --ai openai-compatible: the API base URL")
    .option(
      "--ai-model <model>",
      "for --ai openrouter, ollama-cloud or openai-compatible: the model",
    )
    .option("--key-stdin", "read the API key for --ai from stdin (it goes to .env only)")
    .option("--no-doctor", "don't run the doctor checks at the end")
    .option(
      "--suggest",
      "explore the running app and propose 3 starter tests (AI); each is saved only when you say yes",
    )
    .option(
      "--agents",
      "append the instructions for coding agents to AGENTS.md / CLAUDE.md without asking",
    )
    .action(async (dir: string | undefined, options: InitCommandOptions) => {
      const interactive = process.stdin.isTTY && process.stdout.isTTY && !options.yes;
      process.exitCode = await runInitCommand(dir, options, {
        ...io(),
        ...(interactive ? { ask: terminalAsker() } : {}),
      });
    });
}
