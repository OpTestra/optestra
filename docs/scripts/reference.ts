// Builds the reference pages from the engine itself: the CLI from its commander
// definitions, the project file from the config JSON Schema and built-in defaults,
// the JSON results from their schema, and the lint rules from the reference the
// spec package generates. `pnpm --filter ./docs gen` writes them; a test fails
// when a committed page no longer matches.
import "@testament/spec";
import "@testament/models/section";
import "@testament/decide";
import "@testament/auth";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILT_IN_DEFAULTS, configJsonSchema } from "@testament/config";
import { resultsSummaryJsonSchema } from "@testament/report";
import type { Command, Option } from "commander";
import { toBrandTokens } from "../.vitepress/brand.ts";

export const DOCS_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const ENGINE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const GENERATED = (what: string) =>
  `<!-- Generated from ${what} by \`pnpm --filter ./docs gen\`. Do not edit: a test fails when this page is out of date. -->`;

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Descriptions are plain text: show placeholders like <file> and {{secret.NAME}} as code. */
const prose = (text: string) =>
  toBrandTokens(text).replace(/<[^<>\s]+>|\{\{[^}]+\}\}/g, (match) => `\`${match}\``);

/** The CLI program, exactly as the published binary builds it. */
export async function loadProgram(): Promise<Command> {
  const { createProgram } = (await import(
    new URL("../../packages/cli/dist/program.js", import.meta.url).href
  )) as { createProgram: () => Command };
  return createProgram();
}

export interface CommandInfo {
  /** e.g. "inbox last" */
  path: string;
  command: Command;
}

export function listCommands(program: Command): CommandInfo[] {
  const out: CommandInfo[] = [];
  const walk = (command: Command, prefix: string) => {
    for (const sub of command.commands) {
      const path = prefix ? `${prefix} ${sub.name()}` : sub.name();
      out.push({ path, command: sub });
      walk(sub, path);
    }
  };
  walk(program, "");
  return out;
}

/** Every flag a command accepts, long and short, including commander's --no- forms. */
export function flagsOf(command: Command): Set<string> {
  const flags = new Set<string>(["-h", "--help"]);
  for (const option of command.options as readonly Option[]) {
    if (option.short) flags.add(option.short);
    if (option.long) flags.add(option.long);
  }
  return flags;
}

function optionRow(option: Option): string {
  const fallback = option.defaultValue;
  const shown =
    fallback === undefined || option.negate ? "" : `\`${cell(JSON.stringify(fallback))}\``;
  return `| \`${cell(option.flags)}\` | ${cell(prose(option.description ?? ""))} | ${shown} |`;
}

export async function cliReference(): Promise<string> {
  const program = await loadProgram();
  const lines = [
    GENERATED("the CLI's command definitions (packages/cli/src/program.ts)"),
    "",
    "# CLI reference",
    "",
    `Every command of \`%cli%\`, with its arguments and flags. Every command also takes \`-h, --help\`; \`%cli% -v\` (\`--version\`) prints the engine version. Commands that take \`-C, --dir\` find the project in the nearest folder above the current one that has a \`%config%\`.`,
    "",
    "Exit codes follow one rule for every command that runs or checks something: **0** everything is fine, **1** a real problem (a failed test, a lint error, a failed check), **2** couldn't run (blocked tests, a missing or invalid project file, a missing recording). The guides give each command's exact cases.",
    "",
    "| Command | What it does |",
    "|---|---|",
  ];
  const commands = listCommands(program).filter((info) => info.command.commands.length === 0);
  for (const { path, command } of commands) {
    const anchor = path.replace(/ /g, "-");
    lines.push(`| [\`${path}\`](#${anchor}) | ${cell(prose(command.description()))} |`);
  }
  for (const { path, command } of commands) {
    lines.push("", `## ${path} {#${path.replace(/ /g, "-")}}`, "");
    lines.push(prose(command.description()), "");
    lines.push("```sh", `%cli% ${path} ${command.usage()}`.trimEnd(), "```");
    const args = command.registeredArguments;
    if (args.length > 0) {
      lines.push("", "| Argument | |", "|---|---|");
      for (const arg of args) {
        const name = `${arg.required ? "<" : "["}${arg.name()}${arg.variadic ? "..." : ""}${arg.required ? ">" : "]"}`;
        lines.push(`| \`${name}\` | ${cell(prose(arg.description ?? ""))} |`);
      }
    }
    const options = command.options as readonly Option[];
    if (options.length > 0) {
      lines.push("", "| Option | | Default |", "|---|---|---|");
      for (const option of options) lines.push(optionRow(option));
    }
  }
  return `${lines.join("\n")}\n`;
}

// ── Project file ────────────────────────────────────────────────────────────

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  properties?: Record<string, Schema>;
  additionalProperties?: Schema | boolean;
  propertyNames?: Schema;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  required?: string[];
  pattern?: string;
};

function typeOf(schema: Schema): string {
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" \\| ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return variants.map(typeOf).join(" \\| ");
  if (schema.type === "array") return `list of ${schema.items ? typeOf(schema.items) : "values"}`;
  if (Array.isArray(schema.type)) return schema.type.join(" \\| ");
  if (
    schema.type === "object" &&
    !schema.properties &&
    typeof schema.additionalProperties === "object"
  ) {
    return `map of ${typeOf(schema.additionalProperties)}`;
  }
  return schema.type ?? "value";
}

function objectVariant(schema: Schema): Schema | undefined {
  if (schema.properties) return schema;
  return (schema.anyOf ?? schema.oneOf)?.find((variant) => variant.properties);
}

function defaultAt(path: string[]): unknown {
  let value: unknown = BUILT_IN_DEFAULTS;
  for (const part of path) {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    value = part.startsWith("<") ? record["*"] : record[part];
  }
  return value;
}

function showDefault(value: unknown): string {
  if (value === undefined) return "";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value).length === 0 ? "`{}`" : "";
  }
  return `\`${cell(JSON.stringify(value))}\``;
}

const MAP_KEYS: Record<string, string> = {
  environments: "<env>",
  secrets: "<NAME>",
  providers: "<id>",
  profiles: "<profile>",
  tasks: "<task>",
  prices: "<model>",
  rules: "<rule>",
  vars: "<name>",
  headers: "<header>",
  params: "<param>",
  options: "<option>",
};

function walkSchema(schema: Schema, path: string[], rows: string[]): void {
  const node = objectVariant(schema);
  if (!node?.properties) return;
  for (const [key, child] of Object.entries(node.properties)) {
    const childPath = [...path, key];
    const description = child.description ?? "";
    const overrides = /^Overrides of /.test(description);
    rows.push(
      `| \`${childPath.join(".")}\` | ${typeOf(child)} | ${showDefault(defaultAt(childPath))} | ${cell(prose(description))} |`,
    );
    if (overrides) continue;
    const object = objectVariant(child);
    if (object?.properties) {
      walkSchema(object, childPath, rows);
    } else if (child.type === "object" && typeof child.additionalProperties === "object") {
      const entry = child.additionalProperties;
      if (objectVariant(entry)?.properties) {
        walkSchema(entry, [...childPath, MAP_KEYS[key] ?? "<key>"], rows);
      }
    } else if (child.type === "array" && child.items && objectVariant(child.items)?.properties) {
      walkSchema(child.items, [...childPath, "[]"], rows);
    }
  }
}

export function configReference(): string {
  const schema = configJsonSchema() as Schema;
  const lines = [
    GENERATED("the project file's JSON Schema and built-in defaults (packages/config)"),
    "",
    "# Project file reference",
    "",
    "Every key of `%config%`, with its type, its built-in default and what it does. `<env>`, `<NAME>` and similar stand for names you choose. Unknown keys are a warning (`UNKNOWN_KEY`) and are ignored. The same schema is published as JSON (`%scope%/models/schema.json` holds the project file with the models section), for editors.",
    "",
    "Values are resolved in this order, lowest first: the built-in defaults, the project file, the selected environment's overrides (`run`, `secrets`, `models` and `decisions` can be set inside an environment), environment variables (`%ENV%<SECTION>_<FIELD>`, e.g. `%ENV%RUN_RETRIES=0`), then the flags of the command. `%cli% config` shows the result and where each value came from.",
  ];
  const properties = schema.properties ?? {};
  for (const [section, child] of Object.entries(properties)) {
    const rows: string[] = [];
    rows.push(
      `| \`${section}\` | ${typeOf(child)} | ${showDefault(defaultAt([section]))} | ${cell(prose(child.description ?? ""))} |`,
    );
    const object = objectVariant(child);
    if (object?.properties) walkSchema(object, [section], rows);
    else if (typeof child.additionalProperties === "object") {
      walkSchema(child.additionalProperties, [section, MAP_KEYS[section] ?? "<key>"], rows);
    }
    lines.push("", `## ${section}`, "", "| Key | Type | Default | |", "|---|---|---|---|", ...rows);
  }
  return `${lines.join("\n")}\n`;
}

// ── JSON results ────────────────────────────────────────────────────────────

function walkResults(schema: Schema, path: string, rows: string[]): void {
  const node = objectVariant(schema);
  if (!node?.properties) return;
  const required = new Set(node.required ?? []);
  for (const [key, child] of Object.entries(node.properties)) {
    const childPath = path ? `${path}.${key}` : key;
    rows.push(
      `| \`${childPath}\` | ${typeOf(child)} | ${required.has(key) ? "yes" : ""} | ${cell(child.description ?? "")} |`,
    );
    const object = objectVariant(child);
    if (object?.properties) walkResults(object, childPath, rows);
    else if (child.type === "array" && child.items)
      walkResults(child.items, `${childPath}[]`, rows);
  }
}

export function resultsReference(): string {
  const schema = resultsSummaryJsonSchema() as Schema & { title?: string };
  const rows: string[] = [];
  walkResults(schema, "", rows);
  return `${[
    GENERATED("the results-summary JSON Schema (packages/report)"),
    "",
    "# JSON results reference",
    "",
    `\`%cli% results <runDir> --json\` prints this summary of a run (\`--json <file>\` writes it). It is what coding agents and tools should read: the verdict, cause and headline of every test, the failing check with expected and actual, the failing step, heals and costs. Paths are relative to the run folder. The schema is published as \`%scope%/report/schema/results-summary.json\`.`,
    "",
    `${schema.description ?? ""}`,
    "",
    "| Field | Type | Always present | |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n")}\n`;
}

// ── Lint rules ──────────────────────────────────────────────────────────────

const RULES_START = "<!-- lint-rules:start";
const RULES_END = "<!-- lint-rules:end -->";

/** Outside code, templates like {{secret.NAME}} become code spans (the site renders prose as Vue). */
function codeTemplates(markdown: string): string {
  let fence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) fence = !fence;
      if (fence || /^\s*```/.test(line)) return line;
      return line
        .split("`")
        .map((part, i) => (i % 2 === 0 ? part.replace(/\{\{[^}]+\}\}/g, (m) => `\`${m}\``) : part))
        .join("`");
    })
    .join("\n");
}

export function lintReference(): string {
  const readme = readFileSync(new URL("../../packages/spec/README.md", import.meta.url), "utf8");
  const start = readme.indexOf(RULES_START);
  const end = readme.indexOf(RULES_END);
  if (start < 0 || end < 0) throw new Error("packages/spec/README.md has no lint rule markers");
  const body = readme.slice(readme.indexOf("\n", start) + 1, end).trim();
  return `${[
    GENERATED("the lint rule definitions (packages/spec, via its README's generated reference)"),
    "",
    "# Lint rules",
    "",
    "Vague tests produce meaningless passes: `Expect: it works` can't fail, so it proves nothing. Lint is the first defence, before any AI is involved. It is rule-based and deterministic (the same file and settings always give the same findings), and it runs in the editor as you type, in `%cli% lint`, and in `%cli% doctor`.",
    "",
    "```sh",
    "%cli% lint                  # every test and flow in the project",
    "%cli% lint tests/checkout.test.md --fix   # apply the safe fixes",
    "%cli% lint --strict --json  # CI: warnings fail too; machine-readable",
    "```",
    "",
    "Set a rule's level, or make warnings fail, in the project file:",
    "",
    "```yaml",
    "lint:",
    "  rules:",
    "    compound-expect: off   # off | info | warning | error",
    "    fixed-wait: error",
    "  strict: false           # true: warnings fail the exit code too",
    "```",
    "",
    "`lint` exits 0 with no errors, 1 on a lint error (or a warning with `--strict`), and 2 when a file can't be parsed or expanded, a path doesn't exist or the project file has errors.",
    "",
    "**Expectations are never auto-edited.** A fix that touches an `Expect:`, `Soft:`, `Never:` or exact `expect` line is never applied by `--fix`; the editor offers it for you to apply by hand.",
    "",
    "## Rules",
    "",
    codeTemplates(toBrandTokens(body)),
  ].join("\n")}\n`;
}

export const REFERENCE_PAGES: Record<string, () => string | Promise<string>> = {
  "reference/cli.md": cliReference,
  "reference/config.md": configReference,
  "reference/results-json.md": resultsReference,
  "writing/lint.md": lintReference,
};
