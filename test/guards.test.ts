import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guarantees 1 and 4: the engine never reaches into the closed apps repo,
// ships no telemetry and makes no network calls.

const root = fileURLToPath(new URL("..", import.meta.url));
const self = fileURLToPath(import.meta.url);
const SKIP = new Set([".git", "node_modules", "dist", "coverage"]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : files(path);
    return entry.isFile() ? [path] : [];
  });
}

const rel = (path: string) => relative(root, path).split(sep).join("/");
const code = files(root).filter((f) => f !== self && /\.(c|m)?[jt]sx?$|\.json$|\.ya?ml$/.test(f));
const source = code.filter((f) => /^packages\/[^/]+\/src\//.test(rel(f)) && !/\.test\./.test(f));

function offenders(list: string[], pattern: RegExp): string[] {
  return list.filter((f) => pattern.test(readFileSync(f, "utf8"))).map(rel);
}

describe("engine guards", () => {
  it("does not reference the apps repo", () => {
    expect(offenders(code, /\.\.\/apps\b|["'`]apps\//)).toEqual([]);
  });

  it("makes no network calls", () => {
    const network =
      /\bfetch\s*\(|node:(https?|http2|net|dgram|tls)\b|from\s+["'](https?|net|dgram|tls|undici|axios|got|node-fetch)["']|\bWebSocket\b|XMLHttpRequest/;
    expect(offenders(source, network)).toEqual([]);
  });

  it("depends on no telemetry or analytics libraries", () => {
    const manifests = code.filter((f) => f.endsWith("package.json"));
    const telemetry =
      /"[^"]*(analytics|telemetry|posthog|sentry|mixpanel|amplitude|segment|datadog|opentelemetry|newrelic|bugsnag|rollbar)[^"]*"\s*:/i;
    expect(offenders(manifests, telemetry)).toEqual([]);
  });
});
