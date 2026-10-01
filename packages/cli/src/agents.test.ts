import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { FAILURE_CAUSES } from "@optestra/contract";
import {
  AGENTS_END_MARKER,
  AGENTS_MARKER,
  agentInstructions,
  agentRules,
  agentsSnippet,
  appendAgentsSnippet,
  TOOL_NAMES,
} from "@optestra/mcp";
import { describe, expect, it } from "vitest";
import { createProgram } from "./program.js";

// The instructions for coding agents (AGT-2): the AGENTS.md snippet and the
// Claude Code skill in integrations/ are the text the engine generates, and
// every command, option and MCP tool they name exists.

const root = new URL("../../../integrations/", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), "utf8");
const AGENTS = read("agents/AGENTS.md");
const SKILL = read(`claude-code/skills/${brand.cliName}/SKILL.md`);
const README = read("README.md");

describe("agent instructions", () => {
  it("integrations/agents/AGENTS.md is the generated snippet", () => {
    expect(AGENTS).toBe(agentsSnippet());
    expect(AGENTS.startsWith(`${AGENTS_MARKER}\n`)).toBe(true);
    expect(AGENTS.endsWith(`${AGENTS_END_MARKER}\n`)).toBe(true);
  });

  it("says plainly that expectations must not be changed to make a test pass", () => {
    expect(agentRules()[0]).toMatch(
      /^Never edit an `Expect:` or `Soft:` line to make a failing test pass\./,
    );
    for (const rule of agentRules()) expect(AGENTS).toContain(`- ${rule}\n`);
  });

  it("the Claude Code skill has valid frontmatter and carries the same instructions", () => {
    const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(SKILL);
    expect(match).not.toBeNull();
    const front = Object.fromEntries(
      (match?.[1] ?? "").split("\n").map((line) => {
        const at = line.indexOf(": ");
        return [line.slice(0, at), line.slice(at + 2)];
      }),
    ) as { name: string; description: string };
    expect(front.name).toBe(brand.cliName);
    expect(front.description.length).toBeGreaterThan(40);
    expect(front.description.length).toBeLessThan(1024);
    expect(front.description).toMatch(/Never edit an Expect line/);
    expect(match?.[2]?.startsWith(agentInstructions())).toBe(true);
  });

  it("names only commands, options and MCP tools that exist", () => {
    const program = createProgram();
    const commands = new Map(program.commands.map((c) => [c.name(), c]));
    for (const text of [AGENTS, SKILL, README]) {
      for (const [, name, rest] of text.matchAll(
        new RegExp(`\`(?:npx )?${brand.cliName} ([a-z-]+)([^\`]*)\``, "g"),
      )) {
        const command = commands.get(name as string);
        expect(command, `${name} in ${text.slice(0, 40)}`).toBeDefined();
        for (const [flag] of (rest ?? "").matchAll(/--[a-z-]+/g)) {
          const known = command?.options.some((o) => o.long === flag);
          expect(known, `${name} ${flag}`).toBe(true);
        }
      }
      // snake_case in backticks is a tool, or a failure cause of the results summary.
      for (const [, word] of text.matchAll(/`([a-z]+_[a-z_]+)`/g))
        if (!(FAILURE_CAUSES as readonly string[]).includes(word as string))
          expect(TOOL_NAMES, word).toContain(word);
    }
  });

  it("files are plain: LF endings, no trailing spaces, a final newline", () => {
    for (const text of [AGENTS, SKILL, README]) {
      expect(text).not.toMatch(/\r/);
      expect(text).not.toMatch(/[ \t]+\n/);
      expect(text.endsWith("\n")).toBe(true);
    }
  });

  it("appends once, keeping the file's text", () => {
    expect(appendAgentsSnippet(undefined)).toBe(agentsSnippet());
    expect(appendAgentsSnippet("# Mine")).toBe(`# Mine\n\n${agentsSnippet()}`);
    expect(appendAgentsSnippet("# Mine\n")).toBe(`# Mine\n\n${agentsSnippet()}`);
    expect(appendAgentsSnippet(`# Mine\n\n${agentsSnippet()}`)).toBeNull();
  });
});
