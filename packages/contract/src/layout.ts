/**
 * The run folder, inside the project data dir: `<dataDir>/runs/<runId>/`.
 * Every path in a document is relative to the run folder and uses "/".
 *
 *   run.json
 *   events.ndjson
 *   tests/<testId>/result.json
 *   tests/<testId>/<attempt>/steps/<index>-before.png | <index>-after.png
 *   tests/<testId>/<attempt>/video.webm | trace.zip | console.log | network.har | logcat.txt
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

export const runLayout = {
  testDir: (testId: string) => `tests/${testId}`,
  testResult: (testId: string) => `tests/${testId}/result.json`,
  attemptDir: (testId: string, attempt: number) => `tests/${testId}/${attempt}`,
  attemptFile: (testId: string, attempt: number, file: AttemptFile) =>
    `tests/${testId}/${attempt}/${ATTEMPT_FILES[file]}`,
  screenshot: (testId: string, attempt: number, index: number, when: "before" | "after") =>
    `tests/${testId}/${attempt}/steps/${index}-${when}.png`,
} as const;
