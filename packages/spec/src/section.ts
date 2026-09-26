import { registerSection } from "@testament/config";
import { z } from "zod";

export interface TestsSettings {
  /** Folder with the tests, relative to the project folder. */
  dir: string;
  /** Globs (relative to `dir`) of the files that are tests or flows. */
  include: string[];
}

export const testsSchema = z
  .strictObject({
    dir: z
      .string()
      .min(1)
      .refine((dir) => !dir.split(/[\\/]/).includes(".."), "must stay inside the project folder")
      .describe("Folder with the tests, relative to the project folder."),
    include: z
      .array(z.string().min(1))
      .min(1)
      .describe("Globs (relative to dir) of the files that are tests or flows."),
  })
  .describe("Where the test files are.");

declare module "@testament/config" {
  interface ConfigSections {
    tests: TestsSettings;
  }
}

/** Defaults live in the config package's defaults.yaml. */
registerSection({ key: "tests", schema: testsSchema });
