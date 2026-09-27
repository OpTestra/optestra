import { mkdirSync, writeFileSync } from "node:fs";
import { resultsSummaryJsonSchema } from "./json.js";

// Build step: writes the results summary JSON Schema for other languages and tools.
const dir = new URL("./schema/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(
  new URL("results-summary.schema.json", dir),
  `${JSON.stringify(resultsSummaryJsonSchema(), null, 2)}\n`,
);
