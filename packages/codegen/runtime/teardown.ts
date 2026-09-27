import type { FullConfig } from "@playwright/test";
import { scrubFolder } from "./__SLUG__.reporter";

/**
 * After the whole run: scrubs secrets out of every trace in the output folders.
 * A backstop for runs where `--reporter` replaced the scrubbing reporter.
 */
export default function scrubAfterRun(config: FullConfig): void {
  for (const project of config.projects) scrubFolder(project.outputDir);
}
