import { mkdirSync, writeFileSync } from "node:fs";
import { contractJsonSchemas } from "./json-schema.js";

// Build step: writes dist/schema/*.schema.json for other languages and tools.
const dir = new URL("./schema/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [name, build] of Object.entries(contractJsonSchemas)) {
  const file = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  writeFileSync(new URL(`${file}.schema.json`, dir), `${JSON.stringify(build(), null, 2)}\n`);
}
