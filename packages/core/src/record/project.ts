import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_DEVICE, openSession } from "@optestra/browser";
import { testIdFromPath } from "@optestra/contract";
import { recordingPath, writeRecording } from "@optestra/recording/node";
import { nodeFileReader } from "@optestra/spec/node";
import { freePath, type ProjectDraftOptions, prepare } from "../draft/project.js";
import {
  type RecordedTest,
  type RecordProgress,
  type RecordTestOptions,
  recordTest,
} from "./record.js";

// Recording against a project (AUT-8): a headed browser on the environment's
// baseUrl with the project's secrets (typed values that match one are
// recorded by name), then the test and its recording, returned. `saveRecorded`
// writes both, only when the caller asks, and never over a file.

export interface RecordProjectOptions
  extends Omit<ProjectDraftOptions, "models" | "limits" | "onEvent"> {
  name?: string | undefined;
  onProgress?: ((line: RecordProgress) => void) | undefined;
  /** Test hook: a scripted person using the page. */
  user?: ((user: import("@optestra/browser").ScriptedUser) => void) | undefined;
  /** Default true: the overlay to mark expectations and finish. */
  overlay?: boolean | undefined;
  /** The recording's controls (typed expectations), once it has started. */
  control?: RecordTestOptions["control"];
}

export interface ProjectRecording extends RecordedTest {
  project: string;
  environment: string;
  /** Where it would be saved (a free name in the tests folder). */
  absolutePath: string;
}

export async function recordProject(options: RecordProjectOptions): Promise<ProjectRecording> {
  const prepared = await prepare({ ...options, models: null }, false);
  const { version } = await import("../index.js");
  const session = await openSession({
    headless: options.headless ?? false,
    ...(options.browser ? { browser: options.browser } : {}),
    baseUrl: prepared.baseUrl,
    allowedDomains: prepared.allowedDomains,
    secrets: prepared.secrets,
    allowUpload: { dir: join(prepared.dir, prepared.testsDir) },
    evidence: { trace: false, console: false, network: false, video: false },
  });
  try {
    const recorded = await recordTest({
      session,
      start: options.start,
      name: options.name,
      testsDir: prepared.testsDir,
      pathFor: (name) => freePath(prepared.dir, prepared.testsDir, name),
      config: prepared.config,
      readFile: nodeFileReader(prepared.dir),
      meta: { engineVersion: version(), device: DEFAULT_DEVICE, environment: prepared.environment },
      signal: options.signal,
      onProgress: options.onProgress,
      ...(options.user ? { user: options.user } : {}),
      ...(options.overlay !== undefined ? { overlay: options.overlay } : {}),
      ...(options.control ? { control: options.control } : {}),
    });
    return {
      ...recorded,
      project: prepared.dir,
      environment: prepared.environment,
      absolutePath: join(prepared.dir, ...recorded.path.split("/")),
    };
  } finally {
    await session.close();
  }
}

/**
 * Writes a recorded test and its recording (next to the tests, like authoring's).
 * `file` (default: its suggested path) must be new. The recording follows the
 * file: its test id comes from where the file is saved.
 */
export function saveRecorded(
  recorded: ProjectRecording,
  file: string = recorded.absolutePath,
  testsDir = "tests",
): { test: string; recording: string } {
  const absolute = resolve(file);
  if (existsSync(absolute)) throw new Error(`${absolute} already exists: not saved.`);
  const rel = relative(recorded.project, absolute).split(sep).join("/");
  const inside = !rel.startsWith("..");
  const testPath = inside ? rel : recorded.path;
  const recording = { ...recorded.recording, testId: testIdFromPath(testPath), testPath };
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, recorded.text, { flag: "wx" });
  const target = recordingPath(join(recorded.project, testsDir), recording.testId);
  writeRecording(target, recording);
  return { test: absolute, recording: target };
}
