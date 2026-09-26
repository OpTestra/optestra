import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guarantees: the engine never reaches into the closed apps repo, ships no
// telemetry, and makes network calls only through the models transport.

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

  // THE single network exception (FND-2): the models package, and within it only
  // transport.ts, which pins every request to the configured provider's host.
  const NETWORK_EXCEPTION = "packages/models/src/transport.ts";
  const AI_SDK_PACKAGE = "packages/models/";

  it("makes no network calls outside the one allowed transport file", () => {
    const network =
      /\bfetch\s*\(|globalThis\.fetch|node:(https?|http2|net|dgram|tls)\b|from\s+["'](https?|net|dgram|tls|undici|axios|got|node-fetch)["']|\bWebSocket\b|XMLHttpRequest/;
    expect(offenders(source, network).filter((file) => file !== NETWORK_EXCEPTION)).toEqual([]);
  });

  it("uses the AI SDK only inside the models package", () => {
    const aiSdk = /from\s+["'](ai|@ai-sdk\/[^"']+)["']/;
    expect(offenders(source, aiSdk).filter((file) => !file.startsWith(AI_SDK_PACKAGE))).toEqual([]);
    const manifests = code.filter((f) => f.endsWith("package.json"));
    const dependsOnSdk = /"(ai|@ai-sdk\/[^"]+)"\s*:/;
    expect(offenders(manifests, dependsOnSdk)).toEqual([`${AI_SDK_PACKAGE}package.json`]);
  });

  it("depends on no telemetry or analytics libraries", () => {
    const manifests = code.filter((f) => f.endsWith("package.json"));
    const telemetry =
      /"[^"]*(analytics|telemetry|posthog|sentry|mixpanel|amplitude|segment|datadog|opentelemetry|newrelic|bugsnag|rollbar)[^"]*"\s*:/i;
    expect(offenders(manifests, telemetry)).toEqual([]);
  });
});
