import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { brand } from "@testament/brand";

// What `init` and `doctor` need to know about a repository that already has a
// Playwright setup. Read-only: its config and specs are never changed. The one
// risk is that its own `playwright test` would pick up the specs generated in
// <tests dir>/<data dir>/, so both commands say exactly what line to add.

const CONFIG_NAMES = [
  "playwright.config.ts",
  "playwright.config.mts",
  "playwright.config.cts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
];

export interface PlaywrightSetup {
  /** Config file name, relative to the repository. */
  configFile: string;
  /** Its `testDir` (as written; "." when not set: the config's own folder). */
  testDir: string;
  /** Its `testIgnore` already mentions the data dir. */
  ignoresGenerated: boolean;
}

/** The repository's Playwright config, if it has one. Only reads the file as text. */
export function findPlaywrightSetup(dir: string): PlaywrightSetup | undefined {
  const name = CONFIG_NAMES.find((candidate) => existsSync(join(dir, candidate)));
  if (!name) return undefined;
  const text = readFileSync(join(dir, name), "utf8");
  const testDir = /\btestDir\s*:\s*["'`]([^"'`]+)["'`]/.exec(text)?.[1] ?? ".";
  const ignore = /\btestIgnore\s*:[^\n]*/.exec(text)?.[0] ?? "";
  return { configFile: name, testDir, ignoresGenerated: ignore.includes(brand.dataDirName) };
}

export interface PlaywrightOverlap {
  configFile: string;
  /** The generated specs are already excluded. */
  ignored: boolean;
  /** The exact edit that keeps their runs off the generated specs. */
  fix: string;
}

/** Whether the repository's own Playwright runs would pick up the generated specs. */
export function playwrightOverlap(dir: string, testsDir: string): PlaywrightOverlap | undefined {
  const setup = findPlaywrightSetup(dir);
  if (!setup) return undefined;
  const theirs = resolve(dir, setup.testDir);
  const generated = resolve(dir, testsDir, brand.dataDirName);
  const inside = relative(theirs, generated);
  if (inside.startsWith("..") || isAbsolute(inside)) return undefined;
  const pattern = `"**/${brand.dataDirName}/**"`;
  return {
    configFile: setup.configFile,
    ignored: setup.ignoresGenerated,
    fix: `Add testIgnore: [${pattern}] to the config in ${setup.configFile} (or add ${pattern} to its testIgnore list), so your own runs skip the specs generated in ${testsDir}/${brand.dataDirName}/. Those run with \`npx playwright test -c ${testsDir}/${brand.dataDirName}\`.`,
  };
}
