import { writeFileSync } from "node:fs";
import { configJsonSchema } from "@optestra/config";
import "./config.js";

// Build step: the full project-file schema including the models section.
writeFileSync(
  new URL("./config.schema.json", import.meta.url),
  `${JSON.stringify(configJsonSchema(), null, 2)}\n`,
);
