import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { describe, expect, it } from "vitest";

// Guarantees: the engine never reaches into the closed apps repo, ships no
// telemetry, and makes network calls only through the models transport. (The
// browser harness drives a browser through Playwright; it makes no calls itself.)

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

// Each exception names one file and the imports it may use; the file must still
// make no calls out. Bench fixtures are servers the engine is tested against.
const NETWORK_EXCEPTIONS: Record<string, RegExp> = {
  // The browser harness's refusing proxy (LOOP-0, SAF-1): the browser sends traffic
  // for hosts outside the allowlist here and it refuses all of it. Loopback only,
  // never connects anywhere (checked below). Playwright drives the browser itself.
  "packages/browser/src/refusal-proxy.ts": /from "node:(http|net)";/g,
  // Setup/teardown request hooks (AUT-10) go through Playwright's request context,
  // allowlist-checked first (checked below). Not an agent action.
  "packages/browser/src/session.ts": /this\.#context\.request\.fetch\(/g,
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

  it("keeps the browser harness's refusing proxy on loopback, never connecting out", () => {
    const proxy = readFileSync(join(root, "packages/browser/src/refusal-proxy.ts"), "utf8");
    expect(proxy).toContain('export const PROXY_HOST = "127.0.0.1";');
    expect(proxy).toMatch(/\.listen\(0, PROXY_HOST,/);
    expect([...proxy.matchAll(/\.listen\(/g)]).toHaveLength(1);
    expect(proxy).not.toMatch(/\b(connect|request|get)\(|createConnection|new Socket/);
  });

  it("sends hook requests only after the allowlist check, without following redirects", () => {
    const session = readFileSync(join(root, "packages/browser/src/session.ts"), "utf8");
    expect([...session.matchAll(/\.request\.fetch\(/g)]).toHaveLength(1);
    const hook = session.slice(
      session.indexOf("async hookRequest("),
      session.indexOf("this.#context.request.fetch("),
    );
    expect(hook).toContain("if (!this.#allowlist.allowsUrl(url))");
    expect(session).toContain("maxRedirects: 0,");
  });

  it("keeps fixtures out of engine packages (tests may use them)", () => {
    const packageSource = source.filter((f) => rel(f).startsWith("packages/"));
    expect(offenders(packageSource, new RegExp(`["']${brand.npmScope}/fixture-`))).toEqual([]);
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
