import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { checkKey, type Recording, serializeRecording } from "@testament/recording";
import { describe, expect, it } from "vitest";

// `checks <test>` prints what each Expect line was compiled into, from the recording.

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

function project(checks: Recording["checks"] | null): string {
  const dir = mkdtempSync(join(tmpdir(), "checks-cli-"));
  writeFileSync(
    join(dir, `${brand.cliName}.config.yaml`),
    "version: 1\nproject:\n  name: T\n  target: web\nenvironments:\n  local:\n    baseUrl: http://127.0.0.1:4100\n",
  );
  mkdirSync(join(dir, "tests", `.${brand.cliName}`), { recursive: true });
  writeFileSync(
    join(dir, "tests", "a.test.md"),
    '---\nname: A\n---\n\n1. Expect: the page heading is "Dashboard"\n',
  );
  if (checks) {
    const recording: Recording = {
      recordingVersion: 1,
      testId: "tests__a",
      testPath: "tests/a.test.md",
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
      updatedAt: "2026-01-01T00:00:00.000Z",
      steps: [],
      checks,
    };
    writeFileSync(
      join(dir, "tests", `.${brand.cliName}`, "tests__a.steps.json"),
      serializeRecording(recording),
    );
  }
  return dir;
}

const run = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: "utf8" });

const heading: Recording["checks"][number] = {
  key: checkKey("k1"),
  textKey: "k1",
  text: 'the page heading is "Dashboard"',
  soft: false,
  check: {
    type: "text",
    target: { kind: "role", role: "heading", level: 1 },
    match: "equals",
    value: "Dashboard",
  },
  generatedBy: "rules",
  summary: "Checked that the main heading is exactly 'Dashboard'",
  rule: "heading",
  sanity: { empty: { result: "failed" }, before: { result: "failed" }, provesNothing: false },
  failedAtAuthoring: { expected: "Dashboard", actual: "Something went wrong" },
  recordedAt: "2026-01-01T00:00:00.000Z",
};

describe("checks", { timeout: 30_000 }, () => {
  it("prints each check: summary, op, how it was made, sanity and authoring result", () => {
    const pending: Recording["checks"][number] = {
      key: checkKey("k2"),
      textKey: "k2",
      text: "the chart looks reasonable",
      soft: false,
      check: { type: "pending" },
      generatedBy: "ai",
      recordedAt: "2026-01-01T00:00:00.000Z",
    };
    const dir = project([heading, pending]);
    const result = run(dir, "checks", "tests/a.test.md");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("tests/a.test.md: 2 checks");
    expect(result.stdout).toContain("Checked that the main heading is exactly 'Dashboard'");
    expect(result.stdout).toContain("made by:   rules: heading");
    expect(result.stdout).toContain(
      "sanity:    ok: empty page fails (good); before the action fails (good)",
    );
    expect(result.stdout).toContain(
      'authoring: FAILED: expected "Dashboard", saw "Something went wrong"',
    );
    // A LOOP-1 recording without summaries still gets one.
    expect(result.stdout).toContain("Not checked: this expectation has no compiled check yet");

    const json = JSON.parse(run(dir, "checks", "tests/a.test.md", "--json").stdout);
    expect(json.checks.map((c: { summary: string }) => c.summary)).toEqual([
      "Checked that the main heading is exactly 'Dashboard'",
      "Not checked: this expectation has no compiled check yet",
    ]);
  });

  it("exits 2 when there is no recording or no such file", () => {
    const dir = project(null);
    const missing = run(dir, "checks", "tests/a.test.md");
    expect(missing.status).toBe(2);
    expect(missing.stdout).toContain("has no recording yet");
    expect(run(dir, "checks", "tests/nope.test.md").status).toBe(2);
  });
});
