import { createRequire } from "node:module";

export {
  createLogger,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  logger,
} from "@optestra/config/node";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** Engine version, taken from this package's package.json. */
export function version(): string {
  return pkg.version;
}

export * from "./author/index.js";
export * from "./checks/index.js";
export * from "./draft/index.js";
export * from "./explore/index.js";
export * from "./heal/index.js";
export {
  allowedCommand,
  clientEnv,
  DEFAULT_HOOKS,
  type HookContext,
  type HookExecResult,
  runScriptHook,
  runSqlHook,
  splitCommand,
} from "./hooks/exec.js";
export * from "./record/index.js";
export * from "./run/index.js";
export {
  type AndroidOnlyAction,
  type HarnessAction,
  type HarnessObservation,
  type HarnessOutcome,
  type HarnessSession,
  type TargetName,
  targetOfSession,
} from "./target/harness.js";
export { isScreen } from "./target/render.js";
export { ENGINE_CAPABILITIES, type EngineCapabilities } from "./capabilities.js";
export { parseViewport, VIEWPORT_LIMITS, type ViewportCheck } from "./run/viewport.js";
