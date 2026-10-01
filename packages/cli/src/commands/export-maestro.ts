import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { brand } from "@optestra/brand";
import { ENV_PREFIX } from "@optestra/config";
import type { loadProject } from "@optestra/config/node";
import type { CommandIo } from "./config.js";
import type { ExportCommandOptions } from "./export.js";

// `export` for an Android project (MOB-6, EXP-2): a standalone Maestro workspace.
// It runs with the Maestro CLI alone (`maestro test .`): the flows from codegen's
// generateProject, a workspace config.yaml, and a README with the env vars (secret
// names, no values) and what only the product checks.

/** Folder the flows go to inside the export. */
const FLOWS = "flows";

const code = (text: string) => `\`${text}\``;

/** Exit 0 exported, 1 nothing to export, 2 project problem. */
export async function exportMaestro(context: {
  dir: string;
  out: string;
  options: ExportCommandOptions;
  loaded: ReturnType<typeof loadProject>;
  io: CommandIo;
}): Promise<number> {
  const { dir, out, options, loaded, io } = context;
  const { generateProject } = await import("@optestra/codegen/node");
  const result = await generateProject({
    projectDir: dir,
    environment: options.env,
    env: io.env,
    force: true,
    out: { dir: join(out, FLOWS), label: FLOWS },
  });
  if (!result.ok) {
    for (const problem of result.problems) io.stdout(`error ${problem}\n`);
    return 2;
  }
  const flows = result.files.filter((file) => file.test);
  if (flows.length === 0) {
    for (const s of result.skipped) io.stdout(`  ${"skipped".padEnd(8)} ${s.test} (${s.reason})\n`);
    io.stdout(
      `\nNo recorded tests to export. Record one first: \`${brand.cliName} author <file>\`.\n`,
    );
    return 1;
  }

  const settings = loaded.environment?.settings;
  const secrets = [...new Set(flows.flatMap((f) => f.secrets ?? []))].sort();
  const appIds = [...new Set(flows.flatMap((f) => (f.appId ? [f.appId] : [])))];
  const gaps = flows.flatMap((f) => (f.gaps ?? []).map((gap) => ({ test: f.test ?? "", gap })));
  const baseUrl = `${ENV_PREFIX}BASE_URL`;
  const usesHooks = flows.some((f) => readFileSync(join(out, f.path), "utf8").includes(baseUrl));
  const env = secrets.map((s) => ` -e ${s}=…`).join("");
  const first = flows[0]?.path ?? `${FLOWS}/<flow>`;

  const variables = [
    ...secrets.map((s) => `| ${code(s)} | secret, typed where the test types it (no default) |`),
    ...(usesHooks
      ? [
          `| ${code(baseUrl)} | where setup requests go, from this machine (default ${settings?.baseUrl ?? "none"}) |`,
        ]
      : []),
  ];
  const readme = [
    `# ${loaded.config.project?.name ?? "Tests"}: Maestro flows`,
    "",
    `Exported from ${brand.productName}${loaded.environment ? ` (environment ${code(loaded.environment.name)})` : ""}. These are plain`,
    `[Maestro](https://maestro.dev) flows: they need nothing from ${brand.productName} (no package,`,
    "no account, no key, no servers), only the Maestro CLI, an Android device or emulator",
    `(${code("adb devices")}) and the app installed on it.`,
    "",
    "## Run",
    "",
    "```bash",
    `adb install path/to/app.apk   # ${appIds.join(", ") || "the app under test"}`,
    `maestro test .${env}`,
    `maestro test ${first}${env}   # one flow`,
    "```",
    "",
    "Each flow starts the app with its data cleared and Android's permissions reset",
    `(${code("launchApp: clearState, permissions: all: unset")}), as ${brand.productName} installs the app`,
    "fresh for every test.",
    "",
    "## Environment variables",
    "",
    `Pass them with ${code("-e NAME=value")}. No secret value is in these files.`,
    "",
    "| Variable | What |",
    "|---|---|",
    ...(variables.length ? variables : ["| (none) | |"]),
    ...(usesHooks
      ? [
          "",
          `Setup requests (${code("setup:")}) run on this machine through Maestro's ${code("http")} script`,
          `API before the app starts, the way ${brand.productName} sends them.`,
        ]
      : []),
    "",
    "## Flows",
    "",
    ...flows.map((f) => `- ${code(f.path)} (from ${code(f.test ?? "")})`),
    ...(result.skipped.length
      ? ["", "Not exported:", "", ...result.skipped.map((s) => `- ${code(s.test)}: ${s.reason}`)]
      : []),
    "",
    `## What only ${brand.productName} checks`,
    "",
    "Every step is a comment above its commands. What Maestro can't do faithfully is",
    "left out with a comment, never approximated:",
    "",
    ...(gaps.length
      ? gaps.map((g) => `- ${code(g.test)} ${g.gap}`)
      : ["- nothing: every step and check of these tests is in the flows."]),
    "",
    `Also only in ${brand.productName}: the network guard (Maestro doesn't limit which hosts the app`,
    "reaches), secrets kept out of screenshots, logs and evidence, self-healing when the app",
    "changes (here a changed screen fails the flow), and verdicts with failure causes.",
    "",
    "The files are yours: edit them freely.",
    "",
  ].join("\n");

  const files: Record<string, string> = {
    "config.yaml": [
      `# Maestro workspace: ${code("maestro test .")} runs every flow in ${FLOWS}/.`,
      "flows:",
      `  - "${FLOWS}/*"`,
      "",
    ].join("\n"),
    "README.md": readme,
  };
  mkdirSync(out, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(out, file), content);

  const shown = relative(io.cwd, out) || ".";
  io.stdout(`Exported ${flows.length} flow${flows.length === 1 ? "" : "s"} to ${shown}/\n`);
  for (const file of Object.keys(files).sort()) io.stdout(`  ${file}\n`);
  for (const file of flows) io.stdout(`  ${file.path}\n`);
  for (const s of result.skipped) io.stdout(`  ${"skipped".padEnd(8)} ${s.test} (${s.reason})\n`);
  if (gaps.length)
    io.stdout(
      `\n${gaps.length} step${gaps.length === 1 ? "" : "s"} checked by ${brand.productName} only (see README.md).\n`,
    );
  io.stdout(`\nRun it without ${brand.productName}:\n  cd ${shown}\n  maestro test .${env}\n`);
  return 0;
}
