import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSafeRelativePath } from "../common.js";
import type { Event, EventOf } from "../events.js";
import type { FoldResult } from "../fold.js";
import type { RunBlock } from "../run.js";
import { readRun } from "./reader.js";
import { createRunWriter, type EmitInput } from "./writer.js";

// merge-runs (CLI-3, CI-6): shard run folders → one contract run folder, as if
// one machine had run every test. Each shard's events are kept in their own
// order and interleaved by time; the files they point to are copied under the
// same paths; the writer folds the result, so the merged run.json and result
// files are exactly what an unsharded run would produce from those events.

export class MergeError extends Error {
  override name = "MergeError";
}

export interface MergeRunsOptions {
  /** Run id of the merged run. Default: the out folder's name when it is a ULID, else a new ULID. */
  runId?: string;
}

export interface MergeRunsResult extends FoldResult {
  dir: string;
  /** Tests per shard folder, in the order given. */
  shards: { dir: string; runId: string; tests: number }[];
}

const SAME = ["project", "environment", "target", "mode", "engineVersion"] as const;

type Stamped = { event: Event; shard: number };

/** Interleaves the shards' events by time, never reordering one shard's own events. */
function interleave(streams: Event[][]): Stamped[] {
  const heads = streams.map(() => 0);
  const out: Stamped[] = [];
  for (;;) {
    let pick = -1;
    for (let s = 0; s < streams.length; s++) {
      const next = streams[s]?.[heads[s] ?? 0];
      if (!next) continue;
      const current = pick === -1 ? undefined : streams[pick]?.[heads[pick] ?? 0];
      if (!current || next.ts < current.ts) pick = s;
    }
    if (pick === -1) return out;
    const event = streams[pick]?.[heads[pick] ?? 0] as Event;
    heads[pick] = (heads[pick] ?? 0) + 1;
    out.push({ event, shard: pick });
  }
}

function withoutStamp(event: Event): EmitInput {
  const { seq: _seq, runId: _runId, ...rest } = event as Event & { contractVersion?: string };
  delete (rest as { contractVersion?: string }).contractVersion;
  return rest as EmitInput;
}

/**
 * Merges finished shard run folders into `outDir` (which must not hold a run yet).
 * Throws MergeError when a folder can't be read, the shards come from different
 * projects, environments, modes or engine versions, or two shards ran the same test.
 */
export function mergeRuns(
  dirs: readonly string[],
  outDir: string,
  options: MergeRunsOptions = {},
): MergeRunsResult {
  if (dirs.length === 0) throw new MergeError("Give at least one run folder to merge.");
  const shards = dirs.map((dir) => {
    const read = readRun(dir);
    const errors = read.diagnostics.filter((d) => d.severity === "error");
    if (!read.run || errors.length > 0)
      throw new MergeError(
        `${dir} is not a finished run folder: ${errors.map((d) => `${d.file}: ${d.message}`).join("; ") || "run.json is missing"}`,
      );
    return { dir, run: read.run, events: read.events };
  });

  const first = shards[0] as (typeof shards)[number];
  for (const shard of shards.slice(1))
    for (const key of SAME)
      if (shard.run[key] !== first.run[key])
        throw new MergeError(
          `${shard.dir} has ${key} "${shard.run[key]}" but ${first.dir} has "${first.run[key]}": only shards of one run can be merged.`,
        );
  const owner = new Map<string, string>();
  for (const shard of shards)
    for (const test of shard.run.tests) {
      const other = owner.get(test.testId);
      if (other)
        throw new MergeError(
          `Test "${test.testId}" is in both ${other} and ${shard.dir}: shards must not overlap.`,
        );
      owner.set(test.testId, shard.dir);
    }

  const writer = createRunWriter(outDir, {
    scrub: (text) => text, // already scrubbed by each shard's writer
    ...(options.runId ? { runId: options.runId } : {}),
  });
  const starts = shards.map((s) => s.events.find((e) => e.type === "run.started"));
  const finishes = shards.map((s) =>
    s.events.find((e): e is EventOf<"run.finished"> => e.type === "run.finished"),
  );
  const start = [...starts].sort((a, b) => (a?.ts ?? "").localeCompare(b?.ts ?? ""))[0] as
    | EventOf<"run.started">
    | undefined;
  if (!start) throw new MergeError(`${first.dir} has no run.started event.`);
  writer.emit({
    ...(withoutStamp(start) as EmitInput & { type: "run.started" }),
    git: shards.find((s) => s.run.git)?.run.git ?? null,
  });

  const runLevelPaths = new Set<string>();
  const body = interleave(
    shards.map((s) =>
      s.events.filter((e) => e.type !== "run.started" && e.type !== "run.finished"),
    ),
  );
  for (const { event, shard } of body) {
    let input = withoutStamp(event);
    if (event.type === "artifact.written") {
      const source = shards[shard] as (typeof shards)[number];
      let path = event.artifact.path;
      // Test artifacts live under their test's folder (unique per shard); run-level ones may clash.
      if (event.testId === null) {
        if (runLevelPaths.has(path)) path = `shards/${shard + 1}/${path}`;
        runLevelPaths.add(path);
      }
      if (!isSafeRelativePath(path)) throw new MergeError(`Unsafe artifact path "${path}".`);
      const from = join(source.dir, event.artifact.path);
      if (!existsSync(from))
        throw new MergeError(`${source.dir} is missing its artifact ${event.artifact.path}.`);
      const to = join(outDir, path);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      input = { ...input, artifact: { ...event.artifact, path } } as EmitInput;
    }
    writer.emit(input);
  }

  const lastTs = finishes
    .map((f) => f?.ts ?? "")
    .sort()
    .at(-1) as string;
  const blocked = finishes
    .map((f, i): RunBlock | null =>
      f?.blocked
        ? {
            reason: f.blocked.reason,
            message: shards.length > 1 ? `shard ${i + 1}: ${f.blocked.message}` : f.blocked.message,
          }
        : null,
    )
    .find(Boolean);
  writer.emit({ type: "run.finished", blocked: blocked ?? null, ts: lastTs });
  const folded = writer.finish();
  return {
    ...folded,
    dir: outDir,
    shards: shards.map((s) => ({ dir: s.dir, runId: s.run.runId, tests: s.run.tests.length })),
  };
}
