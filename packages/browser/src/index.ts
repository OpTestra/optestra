/**
 * The browser harness (LOOP-0): a safe, isolated browser session for one test.
 * The agent (LOOP-1) and the replayer (LOOP-4) drive pages only through this.
 * Node only. Safety model and formats: README.md.
 */
export { Allowlist } from "./allowlist.js";
export {
  type CheckEvaluation,
  type CheckOptions,
  type CheckStatus,
  type CheckTarget,
  PageCopy,
} from "./check.js";
export {
  DEFAULT_DEVICE,
  DEVICE_PRESETS,
  type DevicePreset,
  UnknownDeviceError,
} from "./devices.js";
export {
  BrowserSetupError,
  installBrowsers,
  LaunchedBrowser,
  type LaunchOptions,
  launchBrowser,
} from "./launch.js";
export { type RenderOptions, renderForModel } from "./render.js";
export { openSession, Session } from "./session.js";
export * from "./types.js";
