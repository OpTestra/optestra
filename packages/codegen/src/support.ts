import { readFileSync } from "node:fs";
import { brand } from "@optestra/brand";
import { ENV_PREFIX } from "@optestra/config";
import { withHeader } from "./header.js";
import { arr, formatNumber, obj, printModule, quote, str } from "./print/js.js";
import { CHECKED_ELSEWHERE, FIXTURES_MODULE, type GeneratedFile } from "./spec.js";

// The two shared files next to the specs: the fixtures module (allowlist,
// secrets, values, network and inbox helpers) and the Playwright config. Both
// come from templates in `runtime/`, which are real TypeScript kept formatted
// and linted in this repo; the environment they were generated for is baked in
// as defaults that `<PREFIX>_*` variables override.

/** What the shared files need to know about the environment the specs target. */
export interface SupportEnvironment {
  /** Environment name, e.g. `local`; null when the project has none. */
  name: string | null;
  baseUrl: string;
  allowedDomains: string[];
  /** The environment's plain `vars`. */
  vars: Record<string, string>;
  /** Secret name → the domains it may be typed into (never values). */
  secrets: Record<string, string[]>;
  /** Domain for generated email addresses. */
  emailDomain: string;
  /** `run.timeoutSeconds` */
  timeoutSeconds: number;
  /** `run.retries` */
  retries: number;
  /** Project-relative folder of the generated files: `<tests dir>/<data dir>`. */
  specDir: string;
}

export const CONFIG_FILE = "playwright.config.ts";
export const FIXTURES_FILE = `${FIXTURES_MODULE}.ts`;
export const REPORTER_FILE = `${brand.cliName}.reporter.ts`;
export const TEARDOWN_FILE = `${brand.cliName}.teardown.ts`;

const template = (name: string) =>
  readFileSync(new URL(`../runtime/${name}`, import.meta.url), "utf8");

function brandTokens(text: string): string {
  const pascal = CHECKED_ELSEWHERE.slice("checkedBy".length);
  return text
    .replaceAll("__ENV_PREFIX__", ENV_PREFIX)
    .replaceAll("__PASCAL__", pascal)
    .replaceAll("__SLUG__", brand.cliName)
    .replaceAll("__NAME__", brand.productName);
}

function environmentBlock(environment: SupportEnvironment): string {
  const sorted = (record: Record<string, string[]> | Record<string, string>) =>
    Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const generated = obj([
    ["name", environment.name === null ? { t: "raw", text: "null" } : str(environment.name)],
    ["baseUrl", str(environment.baseUrl)],
    ["allowedDomains", arr(environment.allowedDomains.map(str))],
    ["vars", obj(sorted(environment.vars).map((key) => [key, str(environment.vars[key] ?? "")]))],
    [
      "secrets",
      obj(
        sorted(environment.secrets).map((key) => [
          key,
          arr((environment.secrets[key] ?? []).map(str)),
        ]),
      ),
    ],
    ["emailDomain", str(environment.emailDomain)],
  ]);
  return printModule([{ t: "const", name: "generated", init: generated }]).trimEnd();
}

/** The fixtures module: the runtime helpers with the environment filled in. */
export function generateFixtures(environment: SupportEnvironment): GeneratedFile {
  const text = template("fixtures.ts");
  const start = text.indexOf("// @environment-start");
  const end = text.indexOf("// @environment-end");
  if (start < 0 || end < 0) throw new Error("runtime/fixtures.ts lost its environment markers");
  const body = `${text.slice(0, start)}// The environment these specs were generated for.\n${environmentBlock(environment)}${text.slice(end + "// @environment-end".length)}`;
  return {
    name: FIXTURES_FILE,
    content: withHeader(brandTokens(body), {
      from: `the environment "${environment.name ?? "default"}"`,
    }),
  };
}

/** The reporter that scrubs secrets out of kept traces, with the secret names filled in. */
export function generateReporter(environment: SupportEnvironment): GeneratedFile {
  const text = template("reporter.ts");
  const start = text.indexOf("// @secrets-start");
  const end = text.indexOf("// @secrets-end");
  if (start < 0 || end < 0) throw new Error("runtime/reporter.ts lost its secrets markers");
  const names = Object.keys(environment.secrets).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const block = printModule([
    { t: "const", name: "SECRET_NAMES", init: arr(names.map(str)) },
  ]).trimEnd();
  const body = `${text.slice(0, start)}// The secrets the tests may type (names only; values come from the environment).\n${block}${text.slice(end + "// @secrets-end".length)}`;
  return {
    name: REPORTER_FILE,
    content: withHeader(brandTokens(body), {
      from: `the environment "${environment.name ?? "default"}"`,
    }),
  };
}

/** The global teardown that scrubs every trace again after the run. */
export function generateTeardown(environment: SupportEnvironment): GeneratedFile {
  return {
    name: TEARDOWN_FILE,
    content: withHeader(brandTokens(template("teardown.ts")), {
      from: `the environment "${environment.name ?? "default"}"`,
    }),
  };
}

/** `playwright.config.ts`: runs the specs in this folder in Chromium, Firefox and WebKit. */
export function generateConfig(environment: SupportEnvironment): GeneratedFile {
  const text = template(CONFIG_FILE)
    .replace("__TIMEOUT__", formatNumber(environment.timeoutSeconds * 1000))
    .replace("__RETRIES__", String(environment.retries))
    .replace("__BASE_URL__", quote(environment.baseUrl))
    .replace("__SPEC_DIR__", environment.specDir);
  return {
    name: CONFIG_FILE,
    content: withHeader(brandTokens(text), {
      from: `the environment "${environment.name ?? "default"}"`,
    }),
  };
}

/** The shared files. */
export function generateSupportFiles(environment: SupportEnvironment): GeneratedFile[] {
  return [
    generateFixtures(environment),
    generateReporter(environment),
    generateTeardown(environment),
    generateConfig(environment),
  ];
}
