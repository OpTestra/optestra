import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brand } from "@optestra/brand";
import { afterEach, describe, expect, it } from "vitest";
import { runTests } from "./runner.js";

// A run given its id before it starts (a cloud run queued by the platform).

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emptyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "run-id-"));
  dirs.push(dir);
  writeFileSync(join(dir, brand.configFileName), "project:\n  name: empty\n");
  mkdirSync(join(dir, "tests"));
  return dir;
}

describe("runTests({ runId })", () => {
  const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

  it("uses the given id for the run, its folder and its events", async () => {
    const projectDir = emptyProject();
    const seen = new Set<string>();
    const result = await runTests({
      projectDir,
      runId: RUN,
      models: null,
      env: {},
      onEvent: (event) => seen.add(event.runId),
    });
    expect(result.run.runId).toBe(RUN);
    expect(result.dir.endsWith(RUN)).toBe(true);
    expect([...seen]).toEqual([RUN]);
  });

  it("refuses an id that is not a ULID, or one already used", async () => {
    const projectDir = emptyProject();
    await expect(runTests({ projectDir, runId: "../x", models: null, env: {} })).rejects.toThrow(
      /ULID/,
    );
    await runTests({ projectDir, runId: RUN, models: null, env: {} });
    expect(existsSync(join(projectDir, brand.dataDirName, "runs", RUN))).toBe(true);
    await expect(runTests({ projectDir, runId: RUN, models: null, env: {} })).rejects.toThrow(
      /exists already/,
    );
  });
});
