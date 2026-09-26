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
const source = code.filter(
  (f) => /^(packages\/[^/]+|bench\/fixtures\/[^/]+)\/src\//.test(rel(f)) && !/\.test\./.test(f),
);

// Bench fixtures are servers the engine is tested against. Each exception names
// one file and the one import it may use; the file must still make no calls out.
const NETWORK_EXCEPTIONS: Record<string, RegExp> = {
  // Serves the demo shop. Binding to 127.0.0.1 is checked below.
  "bench/fixtures/shop/src/server.ts": /from "node:http";/g,
  // Optional delivery to a local Mailpit inbox; refuses non-loopback hosts.
  "bench/fixtures/shop/src/smtp.ts": /from "node:net";/g,
};

function offenders(list: string[], pattern: RegExp): string[] {
  return list
    .filter((f) => {
      const allowed = NETWORK_EXCEPTIONS[rel(f)];
      const text = readFileSync(f, "utf8");
      return pattern.test(allowed ? text.replace(allowed, "") : text);
    })
    .map(rel);
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

  it("keeps fixture servers on loopback", () => {
    for (const file of Object.keys(NETWORK_EXCEPTIONS)) {
      expect(code.map(rel), file).toContain(file);
    }
    const server = readFileSync(join(root, "bench/fixtures/shop/src/server.ts"), "utf8");
    expect(server).toContain('export const HOST = "127.0.0.1";');
    expect(server).toMatch(/\.listen\([^)]*,\s*HOST,/);
    expect([...server.matchAll(/\.listen\(/g)]).toHaveLength(1);
    const smtp = readFileSync(join(root, "bench/fixtures/shop/src/smtp.ts"), "utf8");
    expect(smtp).toContain('const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);');
  });

  it("serves fixture pages that only talk to their own origin", () => {
    const client = files(root).filter((f) => /^bench\/fixtures\/[^/]+\/public\//.test(rel(f)));
    expect(client.length).toBeGreaterThan(0);
    expect(
      offenders(client, /https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}\/|WebSocket|EventSource/i),
    ).toEqual([]);
  });

  it("depends on no telemetry or analytics libraries", () => {
    const manifests = code.filter((f) => f.endsWith("package.json"));
    const telemetry =
      /"[^"]*(analytics|telemetry|posthog|sentry|mixpanel|amplitude|segment|datadog|opentelemetry|newrelic|bugsnag|rollbar)[^"]*"\s*:/i;
    expect(offenders(manifests, telemetry)).toEqual([]);
  });
});
