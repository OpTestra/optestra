import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FIXTURES = fileURLToPath(new URL("../fixtures/v1/", import.meta.url));
/** Full golden runs. `_`-prefixed folders are special cases (e.g. a future minor version). */
export const GOLDEN = readdirSync(FIXTURES).filter((name) => !name.startsWith("_"));
export const ALL = readdirSync(FIXTURES);
export const fixture = (name: string) => `${FIXTURES}${name}`;
