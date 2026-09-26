import { type BrowserContextOptions, devices } from "playwright";
import data from "./devices.json" with { type: "json" };
import type { BrowserName, Viewport } from "./types.js";

export interface DevicePreset {
  name: string;
  label: string;
  category: "desktop" | "laptop" | "tablet" | "phone";
  /** A Playwright device descriptor name. */
  descriptor?: string;
  viewport?: Viewport;
}

interface DeviceFile {
  presets: Record<string, Omit<DevicePreset, "name">>;
  default: string;
}

const file = data as DeviceFile;

/** Every preset from `devices.json`, by name. */
export const DEVICE_PRESETS: Readonly<Record<string, DevicePreset>> = Object.freeze(
  Object.fromEntries(
    Object.entries(file.presets).map(([name, preset]) => [name, { name, ...preset }]),
  ),
);

export const DEFAULT_DEVICE: string = file.default;

export class UnknownDeviceError extends Error {
  override name = "UnknownDeviceError";
}

/** Context options for a preset on a browser engine, with an optional custom viewport. */
export function deviceOptions(
  name: string | undefined,
  browser: BrowserName,
  viewport?: Viewport,
): BrowserContextOptions {
  const preset = DEVICE_PRESETS[name ?? DEFAULT_DEVICE];
  if (!preset) {
    throw new UnknownDeviceError(
      `Unknown device preset "${name}". Use one of: ${Object.keys(DEVICE_PRESETS).join(", ")}.`,
    );
  }
  let options: BrowserContextOptions = {};
  if (preset.descriptor) {
    const descriptor = devices[preset.descriptor];
    if (!descriptor) {
      throw new UnknownDeviceError(
        `Device preset "${preset.name}" names the unknown descriptor "${preset.descriptor}".`,
      );
    }
    const { defaultBrowserType: _engine, ...rest } = descriptor;
    options = rest;
    // Firefox has no mobile emulation; keep size, scale and touch.
    if (browser === "firefox") delete options.isMobile;
  }
  if (preset.viewport) options.viewport = { ...preset.viewport };
  if (viewport) options.viewport = { ...viewport };
  return options;
}
