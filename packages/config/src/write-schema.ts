import { writeFileSync } from "node:fs";
import { configJsonSchema } from "./index.js";

// Build step: writes dist/config.schema.json for editors and the apps' settings forms.
writeFileSync(
  new URL("./config.schema.json", import.meta.url),
  `${JSON.stringify(configJsonSchema(), null, 2)}\n`,
);
