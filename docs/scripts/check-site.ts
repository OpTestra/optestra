// Checks the built site (docs/dist), after `vitepress build`:
//  - every internal link and #anchor points at a page and a heading that exist;
//  - no page loads anything from another host (scripts, styles, fonts, images);
//  - no web font files are shipped (the theme uses system fonts);
//  - llms.txt links only to files that exist;
//  - no brand placeholder (%Name%, %cli%, …) was left unfilled.
// VitePress itself already fails the build on a link to a missing page.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(DIST);
const pages = files.filter((file) => file.endsWith(".html"));
const problems: string[] = [];
const idsCache = new Map<string, Set<string>>();

function idsOf(file: string): Set<string> {
  let ids = idsCache.get(file);
  if (!ids) {
    ids = new Set(
      [...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ""),
    );
    idsCache.set(file, ids);
  }
  return ids;
}

/** The file a site path points at, or undefined. */
function target(path: string): string | undefined {
  const clean = decodeURIComponent(path).replace(/^\/+/, "");
  const candidates =
    clean === "" || clean.endsWith("/")
      ? [join(DIST, clean, "index.html")]
      : [join(DIST, clean), join(DIST, `${clean}.html`)];
  return candidates.find((file) => existsSync(file) && statSync(file).isFile());
}

const rel = (file: string) => relative(DIST, file).split(sep).join("/");

for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const here = `/${rel(page)}`;
  for (const match of html.matchAll(/<a\s[^>]*href="([^"]*)"/g)) {
    const href = (match[1] ?? "").replace(/&amp;/g, "&");
    if (/^(https?:|mailto:)/.test(href)) continue;
    const [pathPart = "", hash] = href.split("#");
    const resolved = pathPart === "" ? here : new URL(pathPart, `http://site${here}`).pathname;
    const file = target(resolved);
    if (!file) {
      problems.push(`${here}: link to a missing page: ${href}`);
      continue;
    }
    if (hash && file.endsWith(".html") && !idsOf(file).has(decodeURIComponent(hash))) {
      problems.push(`${here}: link to a missing heading: ${href}`);
    }
  }
  // Nothing may load from another host: scripts, styles, preloads, icons, images, frames.
  for (const match of html.matchAll(
    /<(script|link|img|iframe|source)\s[^>]*(?:src|href)="(https?:)?\/\/[^"]*"/g,
  )) {
    problems.push(`${here}: loads from another host: ${match[0].slice(0, 120)}`);
  }
}

for (const css of files.filter((file) => file.endsWith(".css"))) {
  for (const match of readFileSync(css, "utf8").matchAll(
    /url\(\s*["']?((?:https?:)?\/\/[^"')]+)/g,
  )) {
    problems.push(`${rel(css)}: loads from another host: ${match[1]}`);
  }
  if (/@import\s+(url\()?["']?(https?:)?\/\//.test(readFileSync(css, "utf8"))) {
    problems.push(`${rel(css)}: imports a remote stylesheet`);
  }
}

for (const font of files.filter((file) => /\.(woff2?|ttf|otf|eot)$/.test(file))) {
  problems.push(`${rel(font)}: a web font is shipped (the theme should use system fonts)`);
}

const llms = join(DIST, "llms.txt");
if (!existsSync(llms)) problems.push("llms.txt is missing");
else {
  for (const match of readFileSync(llms, "utf8").matchAll(/\]\((\/[^)]+)\)/g)) {
    if (!target(match[1] ?? "")) problems.push(`llms.txt: link to a missing file: ${match[1]}`);
  }
}

const PLACEHOLDER = /%(?:Name|cli|scope|config|dataDir|ENV|Desktop|Web|domain|repo)%/;
for (const file of files.filter((f) => /\.(html|md|txt|js)$/.test(f))) {
  const text = readFileSync(file, "utf8");
  const found = PLACEHOLDER.exec(text);
  if (found) problems.push(`${rel(file)}: unfilled brand placeholder ${found[0]}`);
}

if (problems.length > 0) {
  console.error(
    `docs check: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `docs check: ${pages.length} pages; every internal link and anchor resolves, nothing loads from another host, llms.txt ok`,
);
