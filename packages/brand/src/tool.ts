import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Brand, isBrandKey, resolveBrand } from "./resolve.js";

/*
 * brand-sync: keeps a repo in line with brand.json.
 *
 * Names outside brand.json are allowed only where this tool manages them:
 *  - package specifiers `<npmScope>/<pkg>` (rewritten when the scope changes)
 *  - package.json fields listed in that package's "brand" map, e.g.
 *    { "brand": { "bin": "cliName", "productName": "desktopAppName" } }
 *  - the line after a `brand:next <template>` marker, e.g. `# brand:next {dataDirName}/`
 * brand:check flags every other occurrence outside LICENSE, docs and lockfiles.
 */

export const BRAND_JSON_PATH = fileURLToPath(new URL("../../brand.json", import.meta.url));

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", "out", "release"]);
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);
const MARKER = /^\s*(?:#|\/\/)\s*brand:next (.+)$/;

export interface FileChange {
  file: string;
  before: string;
  after: string;
}

export interface Problem {
  file: string;
  line: number;
  message: string;
}

/** Path comparison that tolerates drive-letter case on Windows. */
function isBrandJson(file: string): boolean {
  return relative(file, BRAND_JSON_PATH) === "";
}

export function loadBrand(path: string = BRAND_JSON_PATH): Brand {
  return resolveBrand(JSON.parse(readFileSync(path, "utf8")));
}

export function listFiles(root: string, extraSkipDirs: readonly string[] = []): string[] {
  const skip = new Set([...SKIP_DIRS, ...extraSkipDirs]);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(path);
      } else if (entry.isFile() && !skip.has(entry.name) && !entry.name.endsWith(".tsbuildinfo")) {
        // Skipped names apply to files too: a git worktree's `.git` is a file with an absolute path.
        files.push(path);
      }
    }
  };
  walk(root);
  return files.sort();
}

function readText(file: string): string | null {
  const buffer = readFileSync(file);
  return buffer.includes(0) ? null : buffer.toString("utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scopePattern(scope: string, rest: string): RegExp {
  return new RegExp(`(?<![\\w@.-])${escapeRegExp(scope)}/${rest}`, "g");
}

function renderTemplate(template: string, brand: Brand): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    if (!isBrandKey(key)) throw new Error(`brand:next marker uses unknown key "${key}"`);
    return brand[key];
  });
}

function splitLines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines: text.split(eol), eol };
}

/** Root package.json depends on `<scope>/brand`; that tells us the scope currently in use. */
export function detectScope(root: string): string | null {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (typeof deps !== "object" || deps === null) continue;
    for (const name of Object.keys(deps)) {
      const match = /^(@[^/]+)\/brand$/.exec(name);
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

function applyMarkers(text: string, brand: Brand): string {
  const { lines, eol } = splitLines(text);
  for (let i = 0; i < lines.length - 1; i++) {
    const match = MARKER.exec(lines[i] ?? "");
    if (!match?.[1]) continue; // whole-line `# brand:next ...` or `// brand:next ...` only
    const indent = /^\s*/.exec(lines[i + 1] ?? "")?.[0] ?? "";
    lines[i + 1] = indent + renderTemplate(match[1].trimEnd(), brand);
  }
  return lines.join(eol);
}

interface ManagedField {
  field: "bin" | "productName";
  value: string;
}

function managedFields(pkg: Record<string, unknown>, brand: Brand, file: string): ManagedField[] {
  const map = pkg.brand;
  if (typeof map !== "object" || map === null) return [];
  return Object.entries(map).map(([field, key]) => {
    if (field !== "bin" && field !== "productName") {
      throw new Error(`${file}: unsupported "brand" field "${field}"`);
    }
    if (typeof key !== "string" || !isBrandKey(key)) {
      throw new Error(`${file}: "brand.${field}" must name a brand key`);
    }
    return { field, value: brand[key] };
  });
}

function replaceProductName(text: string, value: string): string {
  return text.replace(
    /("productName"\s*:\s*)"(?:[^"\\]|\\.)*"/,
    (_match, prefix: string) => prefix + JSON.stringify(value),
  );
}

function replaceBinName(text: string, from: string, to: string): string {
  const binAt = text.indexOf('"bin"');
  const quoted = JSON.stringify(from);
  const at = text.indexOf(quoted, binAt);
  if (binAt < 0 || at < 0) return text;
  return text.slice(0, at) + JSON.stringify(to) + text.slice(at + quoted.length);
}

function singleBinName(pkg: Record<string, unknown>, file: string): string {
  const names = Object.keys((pkg.bin ?? {}) as object);
  if (names.length !== 1 || !names[0]) {
    throw new Error(`${file}: a branded "bin" must have exactly one entry`);
  }
  return names[0];
}

function applyPackageJson(text: string, brand: Brand, file: string): string {
  const pkg = JSON.parse(text) as Record<string, unknown>;
  let out = text;
  for (const { field, value } of managedFields(pkg, brand, file)) {
    out =
      field === "productName"
        ? replaceProductName(out, value)
        : replaceBinName(out, singleBinName(pkg, file), value);
  }
  return out;
}

function toRel(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

/** Every edit `brand:apply` would make to bring the repo in line with the brand. */
export function planBrandApply(root: string, brand: Brand): FileChange[] {
  const oldScope = detectScope(root);
  const changes: FileChange[] = [];
  for (const file of listFiles(root, [brand.dataDirName])) {
    const name = basename(file);
    if (LOCKFILES.has(name) || isBrandJson(file)) continue;
    const before = readText(file);
    if (before === null) continue;
    let after = before;
    if (oldScope && oldScope !== brand.npmScope) {
      after = after.replace(scopePattern(oldScope, ""), `${brand.npmScope}/`);
    }
    after = applyMarkers(after, brand);
    if (name === "package.json") after = applyPackageJson(after, brand, toRel(root, file));
    if (after !== before) changes.push({ file, before, after });
  }
  return changes;
}

function isAllowlisted(rel: string, file: string): boolean {
  const name = basename(rel);
  return (
    isBrandJson(file) ||
    /^LICENSE/i.test(name) ||
    /\.mdx?$/i.test(name) ||
    rel.startsWith("docs/") ||
    LOCKFILES.has(name)
  );
}

/** Blanks out every occurrence brand-sync manages, leaving only stray names. */
function stripManaged(text: string, brand: Brand, name: string, rel: string): string {
  let out = text.replace(scopePattern(brand.npmScope, "[\\w.*-]*"), "");
  if (name === "package.json") {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    for (const { field, value } of managedFields(pkg, brand, rel)) {
      out = field === "productName" ? replaceProductName(out, "") : replaceBinName(out, value, "");
    }
  }
  const { lines, eol } = splitLines(out);
  for (let i = 0; i < lines.length - 1; i++) {
    if (MARKER.test(lines[i] ?? "")) lines[i + 1] = "";
  }
  return lines.join(eol);
}

/** Problems that make `brand:check` fail: pending brand:apply edits and stray name literals. */
export function checkBrand(root: string, brand: Brand): Problem[] {
  const problems: Problem[] = planBrandApply(root, brand).map((change) => ({
    file: toRel(root, change.file),
    line: 0,
    message: "out of sync with brand.json (run `pnpm brand:apply`)",
  }));
  const terms = [...new Set(Object.values(brand).map((value) => value.toLowerCase()))];
  for (const file of listFiles(root, [brand.dataDirName])) {
    const rel = toRel(root, file);
    if (isAllowlisted(rel, file)) continue;
    const text = readText(file);
    if (text === null) continue;
    const lines = splitLines(stripManaged(text, brand, basename(file), rel)).lines;
    lines.forEach((line, index) => {
      const lower = line.toLowerCase();
      const term = terms.find((candidate) => lower.includes(candidate));
      if (term) {
        problems.push({
          file: rel,
          line: index + 1,
          message: `product name literal "${term}"; read it from the brand package instead`,
        });
      }
    });
  }
  return problems;
}
