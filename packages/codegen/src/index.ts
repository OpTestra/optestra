/**
 * Generates plain Playwright specs from recordings (REP-1, EXP-1, promise 2):
 * `<tests dir>/<data dir>/<testId>.spec.ts` plus the shared fixtures module and
 * Playwright config. The output imports only `@playwright/test` and the files
 * next to it. Node only (the runtime templates are read from disk);
 * `@optestra/codegen/node` finds tests and recordings in a project and writes
 * the files.
 */
export { DOCS_URL, type FileState, fileState, type Header, withHeader } from "./header.js";
export {
  type AnyCheckOp,
  type CodegenCheck,
  type CodegenRecording,
  type ParsedCodegenRecording,
  readCodegenRecording,
} from "./recording.js";
export {
  CHECKED_ELSEWHERE,
  FIXTURES_MODULE,
  type GeneratedFile,
  generateSpec,
  recordingFileName,
  recordingKey,
  type SpecSource,
  specFileName,
} from "./spec.js";
export {
  generateMaestroFlow,
  type MaestroFlow,
  type MaestroSource,
  maestroFileName,
  recordedAppId,
} from "./maestro.js";
export {
  CONFIG_FILE,
  FIXTURES_FILE,
  generateConfig,
  generateFixtures,
  generateReporter,
  REPORTER_FILE,
  TEARDOWN_FILE,
  generateTeardown,
  generateSupportFiles,
  type SupportEnvironment,
} from "./support.js";
