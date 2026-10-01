import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { type ArtifactRef, isSafeRelativePath, portablePath } from "../common.js";
import type { ArtifactKind } from "../enums.js";
import { type Event, EventSchema, type EventInput } from "../events.js";
import { type FoldResult, foldEvents } from "../fold.js";
import { EVENTS_FILE, RUN_FILE, runLayout } from "../layout.js";
import { serializeDocument, serializeEvent } from "../serialize.js";
import { isUlid, ulid } from "../ulid.js";
import { CONTRACT_VERSION } from "../version.js";
import { sha256, writeFileAtomic } from "./fs.js";
import { z } from "zod";

/** Replaces secrets in a string. Pass the config redactor: `(t) => redactor.redact(t)`. */
export type Scrub = (text: string) => string;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as a producer emits it: the writer fills seq, runId, contractVersion and (by default) ts. */
export type EmitInput = DistributiveOmit<EventInput, "seq" | "runId" | "ts" | "contractVersion"> & {
  ts?: string;
};

export interface ArtifactInput {
  kind: ArtifactKind;
  /** Relative to the run folder; see runLayout. */
  path: string;
  contentType: string;
  /** The producer's promise that secrets were removed. The writer refuses anything else (EVD-5). */
  scrubbed: boolean;
  testId?: string | null;
  attempt?: number | null;
}

export interface RunWriterOptions {
  scrub: Scrub;
  /** Default: the folder name when it is a ULID, else a new ULID. */
  runId?: string;
  /** Clock for events emitted without `ts`. */
  now?: () => Date;
  /** Every event as written (scrubbed and validated), `artifact.written` included. */
  onEvent?: (event: Event) => void;
}

export interface RunWriter {
  readonly dir: string;
  readonly runId: string;
  /** Scrubs, validates and appends one event to events.ndjson. Returns the event as written. */
  emit(event: EmitInput): Event;
  /** Writes an artifact file and emits artifact.written. Text content is scrubbed again. */
  writeArtifact(artifact: ArtifactInput, content: Uint8Array | string): ArtifactRef;
  /** Folds the events and writes the test results and run.json atomically. */
  finish(): FoldResult;
}

const TEXT_TYPE = /^text\/|[+/](json|xml|x-ndjson)\b/;
const RESERVED = /^(run\.json|events\.ndjson|tests\/[^/]+\/result\.json)$/;

const SHA256 = /^[a-f0-9]{64}$/;

function deepScrub(value: unknown, scrub: Scrub): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => deepScrub(item, scrub));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) =>
        // A hash of the scrubbed bytes can't hold a secret, but a short one (a
        // 6-digit code) can turn up inside its hex: masking that breaks the hash.
        key === "sha256" && typeof item === "string" && SHA256.test(item)
          ? [key, item]
          : [scrub(key), deepScrub(item, scrub)],
      ),
    );
  }
  return value;
}

/**
 * Starts a run folder. Every string in every event and document passes through
 * `scrub` before it touches the disk.
 */
export function createRunWriter(dir: string, options: RunWriterOptions): RunWriter {
  const { scrub } = options;
  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? (isUlid(basename(dir)) ? basename(dir) : ulid());
  if (!isUlid(runId)) throw new Error(`runId "${runId}" is not a ULID`);
  const eventsFile = join(dir, EVENTS_FILE);
  if (existsSync(eventsFile))
    throw new Error(`${eventsFile} already exists: start a new run folder`);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(eventsFile, "a");
  const events: Event[] = [];
  let finished = false;

  const emit = (input: EmitInput): Event => {
    if (finished) throw new Error("the run is finished");
    if (events.length === 0 && input.type !== "run.started")
      throw new Error("the first event must be run.started");
    const scrubbed = deepScrub(input, scrub) as Record<string, unknown>;
    const candidate = {
      ...scrubbed,
      ...(input.type === "run.started" ? { contractVersion: CONTRACT_VERSION } : {}),
      seq: events.length,
      runId,
      ts: scrubbed.ts ?? now().toISOString(),
    };
    const parsed = EventSchema.safeParse(candidate);
    if (!parsed.success)
      throw new Error(`invalid ${input.type} event:\n${z.prettifyError(parsed.error)}`);
    writeSync(fd, serializeEvent(parsed.data));
    events.push(parsed.data);
    options.onEvent?.(parsed.data);
    return parsed.data;
  };

  return {
    dir,
    runId,
    emit,
    writeArtifact(artifact, content) {
      if (artifact.scrubbed !== true)
        throw new Error(
          `refusing unscrubbed artifact "${artifact.path}": remove secrets first and pass scrubbed: true`,
        );
      // Scrubbing can put characters like ":" into a path; keep it valid on every OS.
      const path = portablePath(scrub(artifact.path));
      if (!isSafeRelativePath(path) || RESERVED.test(path))
        throw new Error(
          `artifact path "${path}" must be a relative path to a new file in the run folder`,
        );
      let bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      if (typeof content === "string" || TEXT_TYPE.test(artifact.contentType)) {
        bytes = new TextEncoder().encode(scrub(new TextDecoder().decode(bytes)));
      }
      writeFileAtomic(join(dir, path), bytes);
      const ref: ArtifactRef = {
        kind: artifact.kind,
        path,
        contentType: artifact.contentType,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        scrubbed: true,
      };
      emit({
        type: "artifact.written",
        testId: artifact.testId ?? null,
        attempt: artifact.attempt ?? null,
        artifact: ref,
      });
      return ref;
    },
    finish() {
      if (finished) throw new Error("the run is already finished");
      const result = foldEvents(events);
      for (const test of result.tests)
        writeFileAtomic(join(dir, runLayout.testResult(test.testId)), serializeDocument(test));
      writeFileAtomic(join(dir, RUN_FILE), serializeDocument(result.run));
      fsyncSync(fd);
      closeSync(fd);
      finished = true;
      return result;
    },
  };
}
