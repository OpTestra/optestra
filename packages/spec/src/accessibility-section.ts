import { registerSection } from "@optestra/config";
import { z } from "zod";

// Accessibility warnings (EVD-6): `accessibility: warn` scans every page a run
// visits with axe-core (WCAG 2 A/AA). Shown apart from pass/fail; never a
// blocker. Off by default: replays stay as fast as they are.

export type AccessibilitySetting = "off" | "warn";

export const accessibilitySchema = z
  .enum(["off", "warn"])
  .describe(
    "Accessibility checks (axe-core, WCAG 2 A/AA) on every page a run visits: off, or warn (shown apart, never a failure).",
  );

declare module "@optestra/config" {
  interface ConfigSections {
    accessibility: AccessibilitySetting;
  }
}

/** Defaults live in the config package's defaults.yaml. */
registerSection({ key: "accessibility", schema: accessibilitySchema });
