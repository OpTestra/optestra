import { registerSection } from "@optestra/config";
import { z } from "zod";
import { ANDROID_VERSIONS, DEVICE_PROFILES } from "./sdk.js";

// The `android` config section (TGT-4, MOB-1): which Android version and device
// profile the tests of an Android project run on. Environments may override it;
// run options (the CLI's --android / --device) override both.

export interface AndroidSettings {
  /** An Android version from versions.json, e.g. "16". */
  version: string;
  /** A device profile from devices.json, e.g. "pixel-8". */
  device: string;
}

export const androidSchema = z
  .strictObject({
    version: z
      .string()
      .refine((v) => v in ANDROID_VERSIONS, {
        message: `expected one of ${Object.keys(ANDROID_VERSIONS).join(", ")}`,
      })
      .describe("Android version the tests run on."),
    device: z
      .string()
      .refine((d) => d in DEVICE_PROFILES, {
        message: `expected one of ${Object.keys(DEVICE_PROFILES).join(", ")}`,
      })
      .describe("Device profile the tests run on (screen size and density)."),
  })
  .describe("Android runs: version and device profile (Android projects).");

declare module "@optestra/config" {
  interface ConfigSections {
    android: AndroidSettings;
  }
}

/** Defaults live in the config package's defaults.yaml. */
registerSection({ key: "android", schema: androidSchema, environmentOverride: true });
