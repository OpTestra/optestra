// Writes the generated reference pages. Run after building the engine:
//   pnpm build && pnpm --filter ./docs gen
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_ROOT, REFERENCE_PAGES } from "./reference.ts";

for (const [page, build] of Object.entries(REFERENCE_PAGES)) {
  writeFileSync(join(DOCS_ROOT, page), await build());
  console.log(`wrote docs/${page}`);
}
