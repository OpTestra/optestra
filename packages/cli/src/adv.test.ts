import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import type { ExploreResult } from "@optestra/core";
import type { ProjectRecording } from "@optestra/core/node";
import { afterAll, describe, expect, it } from "vitest";
import { runExplainCommand } from "./commands/explain.js";
import { runExploreCommand } from "./commands/explore.js";
import { runRecordCommand } from "./commands/record.js";
import { shopProject } from "./shop-project.test-support.js";

// explain, record and explore (ADV-0) from the CLI: explain reads a run and
// changes nothing; record and explore save only when asked.

const FIXTURES = fileURLToPath(new URL("../../contract/fixtures/v1/", import.meta.url));
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
function project() {
  const dir = shopProject("cli-adv-");
  temps.push(dir);
  return dir;
}
const io = (dir: string) => {
  let out = "";
  return {
    io: { cwd: dir, env: {}, stdout: (text: string) => (out += text) },
    out: () => out,
  };
};

describe("explain", { timeout: 30_000 }, () => {
  it("explains the latest run by rules, with evidence, and changes nothing", async () => {
    const dir = project();
    const runs = join(dir, brand.dataDirName, "runs", "01M3EG7AG0M0AHEMTHAS09ZS7Y");
    cpSync(join(FIXTURES, "failed-product-bug"), runs, { recursive: true });
    const before = readFileSync(join(runs, "run.json"), "utf8");
    const { io: cli, out } = io(dir);
    expect(await runExplainCommand([], {}, cli)).toBe(0);
    expect(out()).toMatch(/FAILED · cause: product bug/);
    expect(out()).toMatch(/\[E1\] check: Expect:/);
    expect(out()).toContain("Explained by rules (no AI)");
    expect(readFileSync(join(runs, "run.json"), "utf8")).toBe(before);
    const json = io(dir);
    expect(await runExplainCommand([runs, "discount"], { json: true }, json.io)).toBe(0);
    expect(JSON.parse(json.out()).explanations[0].mode).toBe("rules");
    const missing = io(dir);
    expect(await runExplainCommand([runs, "nope"], {}, missing.io)).toBe(2);
    // --ai with no model reachable (no keys, no subscription CLI on this PATH) refuses: no real call.
    const noAi = io(dir);
    expect(await runExplainCommand([], { ai: true }, { ...noAi.io, env: { PATH: "" } })).toBe(2);
    expect(noAi.out()).toMatch(/No AI model is available/);
  });

  it("says when there are no runs", async () => {
    const { io: cli, out } = io(project());
    expect(await runExplainCommand([], {}, cli)).toBe(2);
    expect(out()).toMatch(/No finished runs/);
  });
});

const recorded = (dir: string): ProjectRecording =>
  ({
    ended: "finished",
    name: "Recorded on /login",
    path: "tests/recorded-on-login.test.md",
    absolutePath: join(dir, "tests/recorded-on-login.test.md"),
    project: dir,
    environment: "local",
    text: '---\nname: Recorded on /login\nstart: /login\n---\n\n1. Click "Log in"\n2. Expect: the page heading is "Dashboard"\n',
    lintClean: true,
    findings: [],
    items: [{ kind: "action", text: 'Click "Log in"' }],
    notes: [],
    secrets: [],
    files: [],
    spec: {},
    recording: {
      recordingVersion: 1,
      testId: "tests__recorded-on-login",
      testPath: "tests/recorded-on-login.test.md",
      target: "web",
      recordedWith: {
        engineVersion: "0.1.0",
        epoch: 1,
        browser: "chromium",
        device: "desktop",
        environment: "local",
        model: null,
        promptVersion: null,
      },
      updatedAt: "2026-09-30T00:00:00.000Z",
      steps: [],
      checks: [],
    },
  }) as unknown as ProjectRecording;

describe("record", { timeout: 30_000 }, () => {
  it("prints the recorded test and saves it (with its recording) only when asked", async () => {
    const dir = project();
    const record = (async () => recorded(dir)) as never;
    const plain = io(dir);
    expect(await runRecordCommand({ url: "/login" }, { ...plain.io, record })).toBe(0);
    expect(plain.out()).toContain('    1. Click "Log in"');
    expect(plain.out()).toMatch(/Not saved/);
    expect(existsSync(join(dir, "tests/recorded-on-login.test.md"))).toBe(false);

    const accepted = io(dir);
    expect(await runRecordCommand({ accept: true }, { ...accepted.io, record })).toBe(0);
    expect(existsSync(join(dir, "tests/recorded-on-login.test.md"))).toBe(true);
    expect(
      existsSync(join(dir, "tests", brand.dataDirName, "tests__recorded-on-login.steps.json")),
    ).toBe(true);
    // Never over a file.
    expect(await runRecordCommand({ accept: true }, { ...io(dir).io, record })).toBe(2);
    expect(await runRecordCommand({ out: "a.md", accept: true }, { ...io(dir).io, record })).toBe(
      2,
    );
  });
});

describe("explore", { timeout: 30_000 }, () => {
  it("prints findings and proposals, saves drafts only with --save-drafts, and exits 0", async () => {
    const dir = project();
    const draft = {
      name: 'No error after clicking "Continue"',
      path: "tests/no-error-after-clicking-continue.test.md",
      text: '---\nname: No error\nstart: /\n---\n\n1. Click "Continue"\n2. Expect: the page doesn\'t show "Oops"\n',
      lintClean: true,
      notes: ["It fails now, by design."],
      items: [{ kind: "action", text: 'Click "Continue"' }],
      status: "incomplete",
      actions: 1,
      totals: { aiCalls: 3, costUsd: 0, billing: "subscription" },
    };
    const explore = (async () =>
      ({
        goal: "buy",
        environment: "local",
        draft: { ...draft, status: "impossible", reason: "impossible" },
        findings: [
          {
            id: "F1",
            kind: "broken_link",
            summary: 'The link "Old" on / leads to /old, which answered 404',
            route: "/",
            evidence: ['link "Old" → /old → 404'],
            afterStep: 0,
          },
        ],
        proposals: [draft],
        linksChecked: 4,
        modelCalls: [],
        promptVersion: "explorer-v1",
        notes: [],
      }) as unknown as ExploreResult & { environment: string }) as never;
    const { io: cli, out } = io(dir);
    const before = readdirSync(join(dir, "tests")).sort();
    expect(await runExploreCommand(undefined, { goal: "buy" }, { ...cli, explore })).toBe(0);
    expect(out()).toContain(
      'F1 broken link: The link "Old" on / leads to /old, which answered 404',
    );
    expect(out()).toMatch(/Nothing was saved/);
    expect(readdirSync(join(dir, "tests")).sort()).toEqual(before);
    const saving = io(dir);
    await runExploreCommand(
      undefined,
      { goal: "buy", saveDrafts: "drafts" },
      { ...saving.io, explore },
    );
    expect(readdirSync(join(dir, "drafts"))).toEqual(["no-error-after-clicking-continue.test.md"]);
    expect(await runExploreCommand(undefined, {}, { ...io(dir).io, explore })).toBe(2);
  });
});

describe("lint reads datasets", { timeout: 30_000 }, () => {
  it("reports a missing dataset and a {{data.x}} no column defines", async () => {
    const { runLintCommand } = await import("./commands/lint.js");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const dir = project();
    const test = (dataset: string) =>
      `---\nname: Rows\nstart: /\ndataset: ${dataset}\n---\n\n1. Fill "Email" with {{data.email}}\n2. Expect: the page shows "{{data.plan}}"\n`;
    writeFileSync(join(dir, "tests/rows.test.md"), test("data/missing.csv"));
    const missing = io(dir);
    expect(await runLintCommand(["tests/rows.test.md"], {}, missing.io)).toBe(1);
    expect(missing.out()).toMatch(/DATASET_NOT_FOUND/);
    mkdirSync(join(dir, "tests/data"), { recursive: true });
    writeFileSync(join(dir, "tests/data/users.csv"), "email\nada@example.com\n");
    writeFileSync(join(dir, "tests/rows.test.md"), test("data/users.csv"));
    const column = io(dir);
    expect(await runLintCommand(["tests/rows.test.md"], {}, column.io)).toBe(1);
    expect(column.out()).toMatch(
      /uses \{\{data\.plan\}\}, but tests\/data\/users\.csv has no "plan" column/,
    );
  });
});
