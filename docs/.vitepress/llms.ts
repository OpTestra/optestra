import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brand } from "@optestra/brand";
import { brandText } from "./brand.ts";
import { SECTIONS } from "./pages.ts";

/*
 * llms.txt (llmstxt.org) for AI assistants: a short summary and one link per page,
 * pointing at a plain-Markdown copy of that page (`<page>.md`, next to its .html).
 * llms-full.txt is every page in one file. All built from the page list and the
 * page sources, with brand names filled in.
 */

const SUMMARY = `${brand.productName} tests websites and Android apps from plain-English test files. The first run uses AI to work out the steps and records them; later runs replay the recording with no AI. Every Expect: line becomes a typed check that plain code evaluates, so a pass means a real check passed. Fixes (heals) are proposed for review, never applied silently. The engine, test format, CLI and GitHub Action are open source (MIT); recorded tests also exist as plain Playwright specs you own.`;

const NOTES = [
  "The CLI is `%cli%`; the project file is `%config%`; test files are `*.test.md` in `tests/`.",
  "Exit codes: 0 passed, 1 failed or flaky (healed too unless the heal policy is auto), 2 blocked or configuration error.",
  "Blocked means the test couldn't run (missing secret, app unreachable, …): never a pass, never a failure.",
  "Never edit an Expect: line to make a test pass; fix the app or ask a human.",
];

function stripFrontmatter(text: string): string {
  return text.startsWith("---\n") ? text.slice(text.indexOf("\n---\n", 4) + 5) : text;
}

export function llmsIndex(): string {
  const lines = [`# ${brand.productName}`, "", `> ${SUMMARY}`, ""];
  for (const note of NOTES) lines.push(`- ${brandText(note)}`);
  for (const section of SECTIONS) {
    lines.push("", `## ${brandText(section.text)}`, "");
    for (const page of section.items) {
      lines.push(`- [${brandText(page.text)}](${page.link}.md): ${brandText(page.description)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function writeLlmsFiles(srcDir: string, outDir: string): Promise<void> {
  const full = [llmsIndex()];
  for (const section of SECTIONS) {
    for (const page of section.items) {
      const markdown = brandText(
        stripFrontmatter(readFileSync(join(srcDir, `${page.link}.md`), "utf8")),
      );
      const target = join(outDir, `${page.link}.md`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, markdown);
      full.push(`\n---\n\nSource: ${page.link}.md\n\n${markdown}`);
    }
  }
  writeFileSync(join(outDir, "llms.txt"), full[0] ?? "");
  writeFileSync(join(outDir, "llms-full.txt"), full.join(""));
}
