import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { brand } from "@optestra/brand";
import { ENV_PREFIX, hasErrors } from "@optestra/config";
import { findProject, loadProject, projectFile } from "@optestra/config/node";
import { DEFAULT_TESTS } from "@optestra/spec/node";
import type { Command } from "commander";
import type { CommandIo } from "./config.js";

// `export [--out dir]` (EXP-2): a standalone Playwright project made from the
// recorded tests. It runs with `npm install && npx playwright test` and holds
// no @optestra/* dependency, no secret value and no runtime of ours: the specs
// and helpers come from codegen's generateProject, plus a package.json that
// pins only @playwright/test, a root playwright.config.ts, a README and a
// .env.example with secret names.

export interface ExportCommandOptions {
  out?: string;
  env?: string;
  dir?: string;
  force?: boolean;
}

/** Folder the specs go to inside the export. Uploads (`../files/…`) resolve from here. */
const SPECS = "tests";
const REPORTER = `${brand.cliName}.reporter.ts`;
const TEARDOWN = `${brand.cliName}.teardown.ts`;

/** The @playwright/test version the engine itself runs (playwright and @playwright/test share it). */
export function playwrightVersion(): string {
  const fromBrowser = createRequire(import.meta.resolve("@optestra/browser"));
  const pkg = JSON.parse(readFileSync(fromBrowser.resolve("playwright/package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/** Every file an `upload` action of a recording names (relative to the test's folder). */
function uploadedFiles(recording: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.type === "upload" && Array.isArray(record.files)) {
        for (const file of record.files) if (typeof file === "string") found.add(file);
      }
      for (const item of Object.values(record)) walk(item);
    }
  };
  walk(recording);
  return [...found];
}

/** The generated config, moved to the export's root: paths point into tests/, and .env is loaded. */
function rootConfig(generated: string): string {
  const body = generated.replace(/^(\/\/[^\n]*\n)+\n?/, "");
  const replacements: Array<[string, string]> = [
    [`//   npx playwright test -c ${SPECS}\n`, "//   npx playwright test\n"],
    [
      'import { defineConfig, devices } from "@playwright/test";\n',
      `import { existsSync } from "node:fs";\nimport { join } from "node:path";\nimport { defineConfig, devices } from "@playwright/test";\n\n// Secrets and overrides from .env (see .env.example); variables already set win.\nconst envFile = join(__dirname, ".env");\nif (existsSync(envFile)) process.loadEnvFile(envFile);\n`,
    ],
    ['testDir: ".",', `testDir: "./${SPECS}",`],
    [`"./${REPORTER}"`, `"./${SPECS}/${REPORTER}"`],
    [`globalTeardown: "./${TEARDOWN}"`, `globalTeardown: "./${SPECS}/${TEARDOWN}"`],
  ];
  let text = body;
  for (const [from, to] of replacements) {
    if (!text.includes(from))
      throw new Error(`the generated playwright.config.ts changed shape (no ${from.trim()})`);
    text = text.replace(from, to);
  }
  return text;
}

function readme(options: {
  projectName: string;
  environment: string | null;
  baseUrl: string;
  secrets: string[];
  vars: string[];
  tests: string[];
  skipped: Array<{ test: string; reason: string }>;
  usesInbox: boolean;
}): string {
  const secretLines = options.secrets.length
    ? options.secrets.map(
        (name) =>
          `| \`${name}\` | secret: typed only into its allowed domains, scrubbed from kept traces |`,
      )
    : [];
  const varLines = options.vars.map(
    (name) => `| \`${ENV_PREFIX}VAR_${name}\` | overrides \`{{env.${name}}}\` |`,
  );
  return `# ${options.projectName}: Playwright tests

Exported from ${brand.productName}${options.environment ? ` (environment \`${options.environment}\`)` : ""}. This is a plain
[Playwright](https://playwright.dev) project: it needs nothing from ${brand.productName} (no package,
no account, no key, no servers).

## Run

\`\`\`bash
npm install
npx playwright install chromium   # once; add firefox webkit for the other projects
cp .env.example .env              # then fill in the values
npx playwright test               # Chromium, Firefox and WebKit
npx playwright test --project=chromium
\`\`\`

The tests run against ${options.baseUrl} unless \`${ENV_PREFIX}BASE_URL\` says otherwise.
\`playwright.config.ts\` loads \`.env\`; variables already set in the shell win.

## Environment variables

| Variable | What |
|---|---|
| \`${ENV_PREFIX}BASE_URL\` | the site to test (default ${options.baseUrl}) |
| \`${ENV_PREFIX}ALLOWED_DOMAINS\` | comma-separated hosts the pages may reach (default: the ones the tests were generated with) |
${[...secretLines, ...varLines].join("\n")}${[...secretLines, ...varLines].length ? "\n" : ""}${options.usesInbox ? `| \`${ENV_PREFIX}MAILPIT_URL\` | the Mailpit inbox the email steps read (without it those tests skip) |\n` : ""}
No secret value is in these files: each secret is read from the variable of the same name when it is typed.

## Tests

${options.tests.map((test) => `- \`${SPECS}/${test}\``).join("\n") || "(none)"}
${
  options.skipped.length
    ? `\nNot exported (record them in ${brand.productName} first):\n\n${options.skipped.map((s) => `- \`${s.test}\`: ${s.reason}`).join("\n")}\n`
    : ""
}
## What is portable, and what only ${brand.productName} does

Portable (this project): every step, check and learned wait; the allowed-domains
block (requests to other hosts are aborted); secrets read from the environment,
checked against their domains, masked on screen and scrubbed from kept traces.

Only in ${brand.productName}: self-healing when the page changes (here a changed page fails the
test), model-judged checks and \`Never:\` rules (noted as annotations), saved logins
(\`auth:\` tests skip), verdicts, failure causes and flaky-test detection, and the
secret vault.

The files are yours: edit them freely.
`;
}

/** Exit 0 exported, 1 nothing to export (no recorded tests), 2 project or folder problem. */
export async function runExportCommand(
  options: ExportCommandOptions,
  io: CommandIo,
): Promise<number> {
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  if (!existsSync(projectFile(dir))) {
    io.stdout(`No ${brand.configFileName} found. Run this inside a project, or pass --dir.\n`);
    return 2;
  }
  const loaded = loadProject(dir, { environment: options.env, env: io.env });
  if (hasErrors(loaded.diagnostics)) {
    for (const d of loaded.diagnostics.filter((d) => d.severity === "error")) {
      io.stdout(`error ${d.code}: ${d.message} Fix: ${d.fix}\n`);
    }
    return 2;
  }
  const android = loaded.config.project?.target === "android";
  const out = resolve(io.cwd, options.out ?? (android ? "maestro-export" : "playwright-export"));
  const inside = relative(out, dir);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    io.stdout(`${out} contains the project itself. Choose another --out folder.\n`);
    return 2;
  }
  if (existsSync(out) && !statSync(out).isDirectory()) {
    io.stdout(`${out} is a file. Choose a folder with --out.\n`);
    return 2;
  }
  if (existsSync(out) && readdirSync(out).length > 0 && !options.force) {
    io.stdout(
      `${out} is not empty. Choose an empty or new folder with --out, or pass --force to write into it.\n`,
    );
    return 2;
  }

  if (android) {
    const { exportMaestro } = await import("./export-maestro.js");
    return exportMaestro({ dir, out, options, loaded, io });
  }

  const specsDir = join(out, SPECS);
  const { generateProject } = await import("@optestra/codegen/node");
  const { withHeader } = await import("@optestra/codegen");
  const result = await generateProject({
    projectDir: dir,
    environment: options.env,
    env: io.env,
    force: true,
    out: { dir: specsDir, label: SPECS },
  });
  if (!result.ok) {
    for (const problem of result.problems) io.stdout(`error ${problem}\n`);
    return 2;
  }
  const specs = result.files.filter((file) => file.test);
  if (specs.length === 0) {
    for (const s of result.skipped) io.stdout(`  ${"skipped".padEnd(8)} ${s.test} (${s.reason})\n`);
    io.stdout(
      `\nNo recorded tests to export. Record one first: \`${brand.cliName} author <file>\`.\n`,
    );
    return 1;
  }

  // The config moves to the root, so plain `npx playwright test` finds it.
  const environmentName = loaded.environment?.name ?? null;
  const generatedConfig = join(specsDir, "playwright.config.ts");
  const config = withHeader(rootConfig(readFileSync(generatedConfig, "utf8")), {
    from: `the environment "${environmentName ?? "default"}" (export)`,
  });
  rmSync(generatedConfig);
  writeFileSync(join(out, "playwright.config.ts"), config);

  // Files the upload steps use, at the same place relative to the specs.
  const testsDir = loaded.config.tests?.dir ?? DEFAULT_TESTS.dir;
  const copied: string[] = [];
  const { recordingPath } = await import("@optestra/recording/node");
  for (const spec of specs) {
    const id = spec.path.slice(SPECS.length + 1).replace(/\.spec\.ts$/, "");
    const recordingFile = join(dir, recordingPath(testsDir, id));
    let recording: unknown;
    try {
      recording = JSON.parse(readFileSync(recordingFile, "utf8"));
    } catch {
      continue;
    }
    for (const file of uploadedFiles(recording)) {
      const clean = file.replace(/^\.\//, "");
      const source = resolve(dir, testsDir, clean);
      const target = resolve(out, clean);
      const within = relative(out, target);
      if (within.startsWith("..") || isAbsolute(within) || !existsSync(source)) continue;
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      copied.push(within.split("\\").join("/"));
    }
  }

  const settings = loaded.environment?.settings;
  const secrets = Object.keys(loaded.config.secrets ?? {}).sort();
  const vars = Object.keys(settings?.vars ?? {}).sort();
  const slug =
    (loaded.config.project?.name ?? "tests")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tests";
  const usesInbox = specs.some((spec) =>
    readFileSync(join(out, spec.path), "utf8").includes("inbox."),
  );
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(
      {
        name: `${slug}-playwright`,
        private: true,
        description: `Playwright tests exported from ${brand.productName}. Run: npm install && npx playwright test`,
        scripts: {
          test: "playwright test",
          "install-browsers": "playwright install chromium firefox webkit",
        },
        devDependencies: { "@playwright/test": playwrightVersion() },
      },
      null,
      2,
    )}\n`,
    ".env.example": [
      "# Copy to .env and fill in. Never commit .env.",
      `# ${ENV_PREFIX}BASE_URL=${settings?.baseUrl ?? ""}`,
      ...secrets.map((name) => `${name}=`),
      ...vars.map((name) => `# ${ENV_PREFIX}VAR_${name}=`),
      ...(usesInbox ? [`# ${ENV_PREFIX}MAILPIT_URL=`] : []),
      "",
    ].join("\n"),
    ".gitignore": ["node_modules/", "test-results/", "playwright-report/", ".env", ""].join("\n"),
    "README.md": readme({
      projectName: loaded.config.project?.name ?? "Tests",
      environment: environmentName,
      baseUrl: settings?.baseUrl ?? "",
      secrets,
      vars,
      tests: specs.map((spec) => spec.path.slice(SPECS.length + 1)),
      skipped: result.skipped,
      usesInbox,
    }),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(out, name), content);

  const shown = relative(io.cwd, out) || ".";
  io.stdout(`Exported ${specs.length} test${specs.length === 1 ? "" : "s"} to ${shown}/\n`);
  for (const name of [...Object.keys(files), "playwright.config.ts"].sort())
    io.stdout(`  ${name}\n`);
  for (const file of result.files.filter((f) => !f.path.endsWith("playwright.config.ts"))) {
    io.stdout(`  ${file.path}\n`);
  }
  for (const file of copied) io.stdout(`  ${file}\n`);
  for (const s of result.skipped) io.stdout(`  ${"skipped".padEnd(8)} ${s.test} (${s.reason})\n`);
  io.stdout(
    `\nRun it without ${brand.productName}:\n  cd ${shown}\n  npm install && npx playwright install chromium\n  npx playwright test${secrets.length ? `   (set ${secrets.join(", ")} first: see .env.example)` : ""}\n`,
  );
  return 0;
}

export function registerExportCommand(program: Command, io: () => CommandIo): void {
  program
    .command("export")
    .description(
      "write a standalone Playwright project from the recorded tests (npm install && npx playwright test), or for an Android project a Maestro workspace (maestro test .)",
    )
    .option("-o, --out <dir>", "folder to create (default: ./playwright-export)")
    .option("-e, --env <name>", "environment whose base URL and allowed domains the tests use")
    .option("--force", "write into a folder that isn't empty")
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .action(async (options: ExportCommandOptions) => {
      process.exitCode = await runExportCommand(options, io());
    });
}
