import { portableSegment } from "./common.js";

/**
 * The run folder, inside the project data dir: `<dataDir>/runs/<runId>/`.
 * Every path in a document is relative to the run folder and uses "/".
 *
 *   run.json
 *   events.ndjson
 *   tests/<testId>/result.json
 *   tests/<testId>/<attempt>/steps/<index>-before.png | <index>-after.png   (.jpg for passing steps)
 *   tests/<testId>/<attempt>/video.webm | trace.zip | console.log | network.har | logcat.txt
 *   tests/<testId>/<attempt>/heals/<healId>.json   (1.2: what a heal changes in the recording)
 *   heals/review.json                              (1.2: accept/reject decisions, after the run)
 */
export const RUNS_DIR = "runs";
export const RUN_FILE = "run.json";
export const EVENTS_FILE = "events.ndjson";

export const ATTEMPT_FILES = {
  video: "video.webm",
  trace: "trace.zip",
  console: "console.log",
  network: "network.har",
  logcat: "logcat.txt",
} as const;
export type AttemptFile = keyof typeof ATTEMPT_FILES;

/** A test's folder name: the test id, made portable (ids from `testIdFromPath` already are). */
const dirOf = (testId: string) => portableSegment(testId);

export const runLayout = {
  testDir: (testId: string) => `tests/${dirOf(testId)}`,
  testResult: (testId: string) => `tests/${dirOf(testId)}/result.json`,
  attemptDir: (testId: string, attempt: number) => `tests/${dirOf(testId)}/${attempt}`,
  attemptFile: (testId: string, attempt: number, file: AttemptFile) =>
    `tests/${dirOf(testId)}/${attempt}/${ATTEMPT_FILES[file]}`,
  /** `jpg` for steps that passed (PERF-0), `png` otherwise. */
  screenshot: (
    testId: string,
    attempt: number,
    index: number,
    when: "before" | "after",
    ext: "png" | "jpg" = "png",
  ) => `tests/${dirOf(testId)}/${attempt}/steps/${index}-${when}.${ext}`,
  healPatch: (testId: string, attempt: number, healId: string) =>
    `tests/${dirOf(testId)}/${attempt}/heals/${portableSegment(healId)}.json`,
  healReview: "heals/review.json",
} as const;
