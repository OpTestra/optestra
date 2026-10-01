import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, ulid } from "@optestra/contract";
import { createRunWriter, type EmitInput, mergeRuns, readRun } from "@optestra/contract/node";
import { selectShard } from "@optestra/core/node";
import { renderJsonSummary, renderJunit, renderMarkdownSummary } from "@optestra/report";
import { afterAll, describe, expect, it } from "vitest";

// Shard split + merge-runs round trip (CI-6): a run split into shards by test
// id and merged back validates and reports exactly like the unsharded run.

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const fixtures = fileURLToPath(new URL("../../contract/fixtures/v1/", import.meta.url));
const scratch: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-merge-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

type Sourced = { event: Event; from: string };

const strip = (event: Event): EmitInput => {
  const { seq: _s, runId: _r, ...rest } = event as Event & { contractVersion?: string };
  delete (rest as { contractVersion?: string }).contractVersion;
  return rest as EmitInput;
};

/** Writes events (keeping their times) into a new run folder, copying each artifact from its source. */
function writeRun(dir: string, events: Sourced[], rename: (text: string) => string = (t) => t) {
  const writer = createRunWriter(dir, { scrub: (text) => text, runId: ulid() });
  for (const { event, from } of events) {
    const input = JSON.parse(rename(JSON.stringify(strip(event)))) as EmitInput;
    if (event.type === "artifact.written" && input.type === "artifact.written") {
      const to = join(dir, input.artifact.path);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(from, event.artifact.path), to);
    }
    writer.emit(input);
  }
  return writer.finish();
}

/** One bigger web run from the golden fixtures: every test, ids made unique per fixture. */
function bigRun(): string {
  const names = ["all-passed", "failed-product-bug", "flaky", "blocked-missing-secret"];
  const parts = names.map((name) => ({
    name,
    dir: join(fixtures, name),
    ...readRun(join(fixtures, name)),
  }));
  const body: (Sourced & { rename: (text: string) => string })[] = [];
  for (const part of parts) {
    const rename = (text: string) =>
      text.replace(/tests__([a-z0-9_-]+)/g, (_m, rest: string) => `tests__${part.name}__${rest}`);
    for (const event of part.events)
      if (event.type !== "run.started" && event.type !== "run.finished")
        body.push({ event, from: part.dir, rename });
  }
  body.sort((a, b) => a.event.ts.localeCompare(b.event.ts));
  const first = parts[0]?.events[0] as Event;
  const last = parts
    .map((p) => p.events.at(-1) as Event)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .at(-1) as Event;
  const dir = join(temp(), "unsharded");
  const writer = createRunWriter(dir, { scrub: (text) => text, runId: ulid() });
  writer.emit(strip(first));
  for (const { event, from, rename } of body) {
    const input = JSON.parse(rename(JSON.stringify(strip(event)))) as EmitInput;
    if (event.type === "artifact.written" && input.type === "artifact.written") {
      const to = join(dir, input.artifact.path);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(from, event.artifact.path), to);
    }
    writer.emit(input);
  }
  writer.emit({ ...strip(last), type: "run.finished", blocked: null });
  writer.finish();
  return dir;
}

/** Splits a run folder into `total` shard folders exactly as `--shard i/n` would pick the tests. */
function split(source: string, total: number): string[] {
  const { events } = readRun(source);
  const ids = [...new Set(events.flatMap((e) => (e.type === "test.started" ? [e.testId] : [])))];
  const root = temp();
  return Array.from({ length: total }, (_, i) => {
    const mine = new Set(selectShard(ids, { index: i + 1, total }, (id) => id));
    const keep = events.filter((e) => {
      const testId = (e as { testId?: string | null }).testId;
      if (testId === undefined || testId === null) return i === 0 || e.type.startsWith("run.");
      return mine.has(testId);
    });
    const dir = join(root, `shard-${i + 1}`, ulid());
    writeRun(
      dir,
      keep.map((event) => ({ event, from: source })),
    );
    return dir;
  });
}

const normalize = (text: string, runIds: string[]) =>
  runIds.reduce((out, id) => out.split(id).join("RUN_ID"), text);

describe("merge-runs", () => {
  it("merges 4 shards into a run that reports exactly like the unsharded one", () => {
    const source = bigRun();
    const original = readRun(source);
    expect(original.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(original.run?.totals.tests).toBe(7);

    const shards = split(source, 4);
    expect(shards.map((dir) => readRun(dir).run?.tests.length)).toEqual([2, 2, 2, 1]);
    const out = join(temp(), "merged");
    const merged = mergeRuns(shards, out);

    const read = readRun(out, { verifyArtifacts: true });
    expect(read.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const runIds = [original.run?.runId as string, merged.run.runId];
    const same = (value: unknown) => normalize(JSON.stringify(value), runIds);
    expect(same({ ...merged.run })).toBe(same({ ...original.run }));
    for (const test of original.tests)
      expect(same(merged.tests.find((t) => t.testId === test.testId))).toBe(same(test));
    const data = (r: typeof original) => ({
      run: r.run as NonNullable<typeof r.run>,
      tests: r.tests,
    });
    for (const render of [
      (d: ReturnType<typeof data>) => renderMarkdownSummary(d),
      (d: ReturnType<typeof data>) => renderJunit(d),
      (d: ReturnType<typeof data>) => renderJsonSummary(d, { healedCountsAsPass: false }),
    ])
      expect(normalize(render(data(read)), runIds)).toBe(normalize(render(data(original)), runIds));
  });

  it("refuses overlapping shards and shards of different runs", () => {
    const a = join(fixtures, "all-passed");
    expect(() => mergeRuns([a, join(fixtures, "failed-product-bug")], join(temp(), "x"))).toThrow(
      /in both/,
    );
    expect(() => mergeRuns([a, join(fixtures, "healed")], join(temp(), "y"))).toThrow(
      /environment "local"/,
    );
  });

  it("finds shard folders the way download-artifact lays them out, and exits like run", () => {
    const shards = split(join(fixtures, "failed-product-bug"), 2);
    const root = dirname(dirname(shards[0] as string));
    const out = join(temp(), "merged");
    const result = spawnSync(process.execPath, [bin, "merge-runs", root, "--out", out], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    expect(result.stdout).toContain("Merged 2 run folders");
    expect(result.stdout).toContain("1 passed, 1 failed");
    expect(result.status).toBe(1);
    expect(JSON.parse(readFileSync(join(out, "run.json"), "utf8")).totals.tests).toBe(2);
    const empty = spawnSync(process.execPath, [bin, "merge-runs", temp(), "--out", out], {
      encoding: "utf8",
    });
    expect(empty.status).toBe(2);
    expect(empty.stdout).toContain("No run folders");
  });
});
