// The docs are true to the code: every documented command and flag exists, every
// project-file key shown exists, the generated reference pages match the engine,
// and every page is in the site's navigation. (The built site's links are checked
// by scripts/check-site.ts after `vitepress build`.)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { configJsonSchema } from "@testament/config";
import type { Command } from "commander";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { BRAND_TOKENS, brandText, toBrandTokens } from "../.vitepress/brand.ts";
import { SECTIONS } from "../.vitepress/pages.ts";
import {
  DOCS_ROOT,
  ENGINE_ROOT,
  flagsOf,
  listCommands,
  loadProgram,
  REFERENCE_PAGES,
} from "../scripts/reference.ts";

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

const pages = markdownFiles(DOCS_ROOT);
const README = join(ENGINE_ROOT, "README.md");
/** Every documented source: the site's pages (placeholders filled in) and the engine README. */
const sources = [...pages, README].map((file) => ({
  file: relative(ENGINE_ROOT, file).split(sep).join("/"),
  text: brandText(readFileSync(file, "utf8")),
}));

interface Block {
  lang: string;
  lines: string[];
}

function codeBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let open: { fence: string; block: Block } | undefined;
  for (const line of text.split("\n")) {
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
    if (open) {
      if (fence && fence[1] === open.fence && line.trim() === open.fence) {
        blocks.push(open.block);
        open = undefined;
      } else open.block.lines.push(line);
    } else if (fence) {
      open = { fence: fence[1] as string, block: { lang: fence[2] ?? "", lines: [] } };
    }
  }
  return blocks;
}

function inlineCode(text: string): string[] {
  const withoutBlocks = text.replace(/^\s*(`{3,})[\s\S]*?^\s*\1\s*$/gm, "");
  return [...withoutBlocks.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].map((m) => m[1] as string);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const CLI = BRAND_TOKENS["%cli%"] as string;
/** `cli …` at the start of a command: line start, after npx, a shell separator or `$(`. */
const INVOCATION = new RegExp(`(?:^|[\\s;&|(]|npx\\s+)${CLI}\\s+([^;&|\`]*)`, "g");

interface Invocation {
  file: string;
  args: string[];
}

function invocations(): Invocation[] {
  const found: Invocation[] = [];
  const scan = (file: string, line: string) => {
    const code = line.replace(/\s#.*$/, ""); // shell comments
    for (const match of code.matchAll(INVOCATION)) {
      found.push({ file, args: (match[1] ?? "").trim().split(/\s+/).filter(Boolean) });
    }
  };
  for (const { file, text } of sources) {
    for (const block of codeBlocks(text)) for (const line of block.lines) scan(file, line);
    for (const span of inlineCode(text)) {
      if (new RegExp(`^(npx\\s+)?${CLI}\\s`).test(span)) scan(file, span);
    }
  }
  return found;
}

describe("the docs are true to the CLI", () => {
  let program: Command;
  beforeAll(async () => {
    program = await loadProgram();
  });

  it("documents only commands and flags that exist", () => {
    const problems: string[] = [];
    const all = invocations();
    expect(all.length).toBeGreaterThan(100);
    for (const { file, args } of all) {
      let command = program;
      let index = 0;
      for (; index < args.length; index++) {
        const word = args[index] as string;
        const sub = command.commands.find((c) => c.name() === word);
        if (!sub) break;
        command = sub;
      }
      const first = args[index];
      if (command === program && first !== undefined && !first.startsWith("-")) {
        problems.push(`${file}: unknown command "${CLI} ${first}"`);
        continue;
      }
      const flags =
        command === program ? new Set(["-v", "--version", "-h", "--help"]) : flagsOf(command);
      for (const raw of args.slice(index)) {
        const flag = raw.replace(/^[[(|"']+|[\])|,."':…]+$/g, "").split("=")[0] as string;
        if (!/^--?[A-Za-z]/.test(flag)) continue;
        if (!flags.has(flag)) {
          const path = listCommands(program).find((c) => c.command === command)?.path ?? "";
          problems.push(`${file}: "${CLI} ${path}" has no flag ${flag}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps the generated reference pages up to date (pnpm --filter ./docs gen)", async () => {
    for (const [page, build] of Object.entries(REFERENCE_PAGES)) {
      const committed = readFileSync(join(DOCS_ROOT, page), "utf8");
      expect(committed, `docs/${page} is out of date: run pnpm --filter ./docs gen`).toBe(
        await build(),
      );
    }
  });

  it("documents every command in the CLI reference", async () => {
    const reference = readFileSync(join(DOCS_ROOT, "reference/cli.md"), "utf8");
    for (const { path, command } of listCommands(program)) {
      if (command.commands.length === 0) expect(reference).toContain(`## ${path} {#`);
    }
  });
});

// ── Project file ────────────────────────────────────────────────────────────

type Schema = {
  properties?: Record<string, Schema>;
  additionalProperties?: Schema | boolean;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
};

const schema = configJsonSchema() as Schema;
const SECTION_KEYS = new Set(Object.keys(schema.properties ?? {}));

function objectNode(node: Schema): Schema {
  if (node.properties || node.additionalProperties) return node;
  return (node.anyOf ?? node.oneOf)?.find((v) => v.properties || v.additionalProperties) ?? node;
}

/** The schema at a key path, or undefined when the path doesn't exist. */
function lookup(path: string[]): Schema | undefined {
  let node: Schema | undefined = schema;
  for (const key of path) {
    if (!node) return undefined;
    const object = objectNode(node);
    if (key === "[]") {
      node = object.items;
      continue;
    }
    const named = object.properties?.[key];
    if (named) node = named;
    else if (typeof object.additionalProperties === "object") node = object.additionalProperties;
    else return undefined;
  }
  return node;
}

function keyPaths(value: unknown, path: string[] = []): string[][] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, [...path, "[]"]));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, inner]) => [
      [...path, key],
      ...keyPaths(inner, [...path, key]),
    ]);
  }
  return [];
}

describe("the docs are true to the project file", () => {
  it("shows only keys that exist in project-file snippets", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const { file, text } of sources) {
      for (const block of codeBlocks(text)) {
        if (block.lang !== "yaml" && block.lang !== "yml") continue;
        const source = block.lines.join("\n");
        const docs = parseAllDocuments(source);
        const errors = docs.flatMap((doc) => doc.errors);
        if (errors.length > 0) {
          problems.push(`${file}: invalid YAML: ${errors[0]?.message.split("\n")[0]}`);
          continue;
        }
        const value = docs[0]?.toJS() as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        // A project-file snippet: every top-level key is a section of the project file.
        const top = Object.keys(value);
        if (!top.every((key) => SECTION_KEYS.has(key))) continue;
        if (/frontmatter/.test(block.lines[0] ?? "")) continue;
        checked++;
        for (const path of keyPaths(value)) {
          if (!lookup(path)) problems.push(`${file}: no project-file key ${path.join(".")}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(15);
    expect(problems).toEqual([]);
  });

  it("names only keys that exist when it writes a key path in the text", () => {
    const problems: string[] = [];
    const sections = [...SECTION_KEYS].join("|");
    const pathLike = new RegExp(`^(?:${sections})(?:\\.[A-Za-z0-9_<>*-]+)+$`);
    for (const { file, text } of sources) {
      for (const span of inlineCode(text)) {
        const candidate = span.replace(/:\s.*$/, "");
        if (!pathLike.test(candidate)) continue;
        if (/\.(json|ya?ml|md|ts|js|html|png|txt|ndjson|zip|webm|har|log)$/.test(candidate))
          continue;
        // `{{inbox.code}}` and friends are test variables, not settings.
        if (/^inbox\.(code|link|subject|\*)$/.test(candidate)) continue;
        const path = candidate.split(".").map((part) => (part.startsWith("<") ? "*" : part));
        if (!lookup(path)) problems.push(`${file}: no project-file key ${candidate}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

// ── The site ────────────────────────────────────────────────────────────────

describe("the site", () => {
  it("lists every page in the navigation, and every navigation entry is a page", () => {
    const links = SECTIONS.flatMap((section) => section.items.map((page) => page.link));
    const files = pages
      .map((file) => relative(DOCS_ROOT, file).split(sep).join("/"))
      .filter((file) => file !== "index.md");
    expect(files.map((file) => `/${file.replace(/\.md$/, "")}`).sort()).toEqual([...links].sort());
    for (const link of links) expect(existsSync(join(DOCS_ROOT, `${link}.md`)), link).toBe(true);
  });

  it("uses only known brand placeholders", () => {
    const known = new Set(Object.keys(BRAND_TOKENS));
    for (const file of pages) {
      for (const match of readFileSync(file, "utf8").matchAll(/%[A-Za-z]+%/g)) {
        expect(known, `${relative(DOCS_ROOT, file)}: ${match[0]}`).toContain(match[0]);
      }
    }
  });

  it("writes brand names only as placeholders", () => {
    const name = BRAND_TOKENS["%Name%"] as string;
    for (const file of pages) {
      const text = readFileSync(file, "utf8").replace(/https?:\/\/\S+/g, "");
      const lines = text.split("\n").filter((line) => toBrandTokens(line) !== line);
      expect(lines, `${relative(DOCS_ROOT, file)} writes "${name}" literally`).toEqual([]);
    }
  });
});
