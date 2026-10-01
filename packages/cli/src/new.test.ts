import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectDraft } from "@optestra/core/node";
import { afterAll, describe, expect, it } from "vitest";
import { runNewCommand } from "./commands/new.js";
import { shopProject } from "./shop-project.test-support.js";

// `new "<sentence>"` (AUT-7): prints the draft and where it would go, and writes
// only with --accept (lint-clean, into the tests folder) or --out, or a yes in a
// terminal. The drafting itself is tested in core (e2e on the shop).

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const TEXT = `---
name: Returning user can log in
start: /login
---

1. Fill "Email" with ada@example.com
2. Fill "Password" with {{secret.SHOP_PASSWORD}}
3. Click "Log in"
4. Expect: the page heading is "Dashboard"
`;

function fakeDraft(dir: string, overrides: Partial<ProjectDraft> = {}) {
  const asked: { sentence: string; options: unknown }[] = [];
  const draft = async (sentence: string, options: unknown): Promise<ProjectDraft> => {
    asked.push({ sentence, options });
    return {
      status: "drafted",
      sentence,
      name: "Returning user can log in",
      path: "tests/returning-user-can-log-in.test.md",
      absolutePath: join(dir, "tests/returning-user-can-log-in.test.md"),
      text: TEXT,
      spec: {} as ProjectDraft["spec"],
      findings: [],
      lintClean: true,
      fixed: [],
      items: [],
      notes: [],
      modelCalls: [],
      totals: {
        aiCalls: 3,
        tokens: { input: 1, output: 1, cached: 0, cacheWrite: 0 },
        costUsd: 0,
        unknownCostCalls: 0,
        billing: "subscription",
      },
      promptVersion: "drafter-v1",
      actions: 3,
      durationMs: 1200,
      environment: "local",
      ...overrides,
    };
  };
  return { draft, asked };
}

function project() {
  const dir = shopProject("cli-new-");
  temps.push(dir);
  return dir;
}

async function run(
  dir: string,
  args: Parameters<typeof runNewCommand>[1],
  extra: Partial<Parameters<typeof runNewCommand>[2]> = {},
  sentence = "a returning user can log in",
) {
  let out = "";
  const code = await runNewCommand(sentence, args, {
    cwd: dir,
    env: {},
    stdout: (text) => (out += text),
    ...extra,
  });
  return { code, out };
}

const testsIn = (dir: string) => readdirSync(join(dir, "tests")).sort();

describe("new", () => {
  it("prints the draft and where it would go, and writes nothing", async () => {
    const dir = project();
    const before = testsIn(dir);
    const { draft, asked } = fakeDraft(dir);
    const { code, out } = await run(dir, { start: "/login" }, { draft });
    expect(code).toBe(0);
    expect(out).toContain('    3. Click "Log in"');
    expect(out).toContain("Lint: clean.");
    expect(out).toContain("3 AI calls via your subscription");
    expect(out).toContain(
      "Not saved. It would go to tests/returning-user-can-log-in.test.md: run again with --accept",
    );
    expect(testsIn(dir)).toEqual(before);
    expect(asked[0]).toMatchObject({
      sentence: "a returning user can log in",
      options: { project: dir, start: "/login", headless: true },
    });
  });

  it("--accept saves a lint-clean draft into the tests folder", async () => {
    const dir = project();
    const { draft } = fakeDraft(dir);
    const { code, out } = await run(dir, { accept: true }, { draft });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, "tests/returning-user-can-log-in.test.md"), "utf8")).toBe(TEXT);
    expect(out).toContain("Saved tests/returning-user-can-log-in.test.md");
  });

  it("--accept refuses a draft that doesn't lint clean, or a file that exists", async () => {
    const dir = project();
    const dirty = fakeDraft(dir, {
      lintClean: false,
      notes: ["Lint: vague-step: …"],
    }).draft;
    const refused = await run(dir, { accept: true }, { draft: dirty });
    expect(refused.code).toBe(2);
    expect(refused.out).toContain("Not saved: the draft doesn't lint clean");
    expect(existsSync(join(dir, "tests/returning-user-can-log-in.test.md"))).toBe(false);

    const login = readFileSync(join(dir, "tests/login.test.md"), "utf8");
    const taken = fakeDraft(dir, {
      path: "tests/login.test.md",
      absolutePath: join(dir, "tests/login.test.md"),
    }).draft;
    const exists = await run(dir, { accept: true }, { draft: taken });
    expect(exists.code).toBe(2);
    expect(exists.out).toContain("already exists");
    expect(readFileSync(join(dir, "tests/login.test.md"), "utf8")).toBe(login);
  });

  it("--out writes the draft elsewhere, never over a file", async () => {
    const dir = project();
    const { draft } = fakeDraft(dir, { lintClean: false });
    const first = await run(dir, { out: "draft.test.md" }, { draft });
    expect(first.code).toBe(1);
    expect(readFileSync(join(dir, "draft.test.md"), "utf8")).toBe(TEXT);
    writeFileSync(join(dir, "mine.md"), "keep");
    const second = await run(dir, { out: "mine.md" }, { draft });
    expect(second.code).toBe(2);
    expect(readFileSync(join(dir, "mine.md"), "utf8")).toBe("keep");
    expect((await run(dir, { out: "x.md", accept: true }, { draft })).code).toBe(2);
  });

  it("in a terminal it asks before saving; no means nothing is written", async () => {
    const dir = project();
    const { draft } = fakeDraft(dir);
    const questions: string[] = [];
    const no = await run(
      dir,
      {},
      {
        draft,
        confirm: async (q) => {
          questions.push(q);
          return false;
        },
      },
    );
    expect(no.code).toBe(0);
    expect(questions).toEqual(["\nSave it as tests/returning-user-can-log-in.test.md?"]);
    expect(existsSync(join(dir, "tests/returning-user-can-log-in.test.md"))).toBe(false);
    const yes = await run(dir, {}, { draft, confirm: async () => true });
    expect(yes.out).toContain("Saved tests/returning-user-can-log-in.test.md");
    expect(existsSync(join(dir, "tests/returning-user-can-log-in.test.md"))).toBe(true);
  });

  it("--json prints the draft without saving it", async () => {
    const dir = project();
    const { draft } = fakeDraft(dir);
    const { code, out } = await run(dir, { json: true }, { draft });
    expect(code).toBe(0);
    const json = JSON.parse(out) as { text: string; saved: string | null; lintClean: boolean };
    expect(json).toMatchObject({ text: TEXT, saved: null, lintClean: true });
    expect(existsSync(join(dir, "tests/returning-user-can-log-in.test.md"))).toBe(false);
  });

  it("an unfinished draft exits 1 and says why", async () => {
    const dir = project();
    const { draft } = fakeDraft(dir, {
      status: "incomplete",
      reason: "limit_reached",
      message: "Exploring used its 24 model calls.",
    });
    const { code, out } = await run(dir, {}, { draft });
    expect(code).toBe(1);
    expect(out).toContain("Unfinished (limit_reached): Exploring used its 24 model calls.");
  });

  it("needs a project and a sentence", async () => {
    const dir = project();
    rmSync(join(dir, "tests"), { recursive: true });
    const empty = await run(dir, {}, {}, "  ");
    expect(empty.code).toBe(2);
    const none = await run(join(dir, ".."), { dir: "/nonexistent-project" });
    expect(none.code).toBe(2);
    expect(none.out).toContain("No project file found");
  });
});
