import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { describe, expect, it } from "vitest";

// Guarantees: the engine never reaches into the closed apps repo, ships no
// telemetry, and makes network calls only through four transports: the AI models
// transport, the decision-model (System One) transport, the test inbox
// transport and the GitHub Action's GitHub API transport. (The browser harness
// drives a browser through Playwright; it makes no calls itself. The Android
// harness's network guard and driver link are pinned below: the guard connects
// only to hosts the session allows, the driver link only to 127.0.0.1.)

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

  // The network exceptions, one file each, all pinning every request to the one
  // configured host: the AI models transport (FND-2), the System One transport
  // for the decision models Jev, Kev and Laya via Ollaya (DEC-1), and the test
  // inbox transport for Mailpit, Mailosaur and MailSlurp (AUTH-0), and the GitHub
  // Action's transport to GITHUB_API_URL with the workflow's own token (CI-0).
  const NETWORK_EXCEPTIONS_ENGINE = [
    "packages/models/src/transport.ts",
    "packages/decide/src/node/systemone/transport.ts",
    "packages/auth/src/inbox/transport.ts",
    "packages/action/src/transport.ts",
    // The Android emulator's network guard (MOB-0, SAF-1): it forwards only what the
    // session's allowlist allows (checked below).
    "packages/android/src/guard.ts",
    // The link to the on-device driver, through adb's forward on 127.0.0.1 only.
    "packages/android/src/driver.ts",
    // Android tests' setup/teardown requests (AUT-10): only to an allowed host or the
    // environment's baseUrl, checked before sending (below).
    "packages/android/src/hooks.ts",
    // Bench (BEN-0): is the Android fixture's backend port free? Listens on 127.0.0.1 only.
    "packages/core/src/bench/port.ts",
  ];
  const AI_SDK_PACKAGE = "packages/models/";

  it("makes no network calls outside the allowed transport files", () => {
    const network =
      /\bfetch\s*\(|globalThis\.fetch|node:(https?|http2|net|dgram|tls)\b|from\s+["'](https?|net|dgram|tls|undici|axios|got|node-fetch)["']|\bWebSocket\b|XMLHttpRequest/;
    expect(
      offenders(source, network).filter((file) => !NETWORK_EXCEPTIONS_ENGINE.includes(file)),
    ).toEqual([]);
    // Each exception still exists (a rename must update this list).
    for (const file of NETWORK_EXCEPTIONS_ENGINE) expect(code.map(rel)).toContain(file);
    const port = readFileSync(join(root, "packages/core/src/bench/port.ts"), "utf8");
    expect(port).toContain('server.listen(port, "127.0.0.1",');
    expect(port).not.toMatch(/connect\(|fetch|request\(/);
  });

  it("pins the inbox transport to its one host and never follows redirects", () => {
    const transport = readFileSync(join(root, "packages/auth/src/inbox/transport.ts"), "utf8");
    expect(transport).toContain("if (url.host !== host || url.protocol !== origin.protocol)");
    expect(transport).toContain('redirect: "error"');
  });

  it("pins the GitHub transport to the API host and never follows redirects", () => {
    const transport = readFileSync(join(root, "packages/action/src/transport.ts"), "utf8");
    expect(transport).toContain("if (url.host !== host || url.protocol !== origin.protocol)");
    expect(transport).toContain('redirect: "error"');
    // The Action's code imports only Node built-ins and its own files: it runs from the action folder.
    for (const file of code.filter((f) => rel(f).startsWith("packages/action/src/")))
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g))
        if (!/\.test\./.test(file) && spec) expect(spec, rel(file)).toMatch(/^(node:|\.\/)/);
  });

  // Secret values are revealed only where they are typed or sent to their own host
  // (SEC-1): the browser driver, the three transports' key handling, and the
  // run:/sql: hook runner, which hands them to its own process (AUT-10).
  it("reveals secrets only in the allowed files", () => {
    const reveal = new RegExp(`["']${brand.npmScope}/config/reveal["']`);
    expect(offenders(source, reveal).sort()).toEqual([
      "packages/android/src/session.ts",
      "packages/auth/src/inbox/transport.ts",
      "packages/browser/src/session.ts",
      "packages/core/src/hooks/exec.ts",
      "packages/decide/src/node/systemone/admin.ts",
      "packages/decide/src/node/systemone/client.ts",
      "packages/models/src/check.ts",
      "packages/models/src/client.ts",
    ]);
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

  // Starting other programs: only these files may (MOD-6 delegated CLIs; the
  // browser installer; the brand tool; the Android harness's adb/emulator wrapper,
  // whose closed command list its own tests pin). The delegated runner never uses a shell.
  const SPAWN_ALLOWED = [
    "packages/android/src/tools.ts",
    "packages/brand/src/run.ts",
    "packages/browser/src/launch.ts",
    // Bench (BEN-0): the shop's generated specs through a Node + Playwright Test's CLI, no shell.
    "packages/core/src/bench/fixtures.ts",
    // run:/sql: hooks (AUT-10): an allowlisted command or the database client, no shell.
    "packages/core/src/hooks/exec.ts",
    // Tests with code steps run through their generated spec: Node + Playwright Test's CLI (LOOP-4).
    "packages/core/src/run/spec-run.ts",
    "packages/models/src/delegated/process.ts",
    // `report --open`: the system opener with the report path, no shell.
    "packages/report/src/node/open.ts",
  ];

  it("starts other programs only from the named files, never through a shell", () => {
    const spawners = source
      .filter((f) =>
        /from "node:child_process"|require\("node:child_process"\)/.test(readFileSync(f, "utf8")),
      )
      .map(rel);
    expect(spawners.sort()).toEqual(SPAWN_ALLOWED);
    const delegated = readFileSync(join(root, "packages/models/src/delegated/process.ts"), "utf8");
    expect(delegated).toContain("shell: false,");
    expect(delegated).not.toMatch(/shell:\s*true|execSync|execFile|import \{[^}]*\bexec\b/);
    // It runs only the resolved CLI binary (or a Node for a JS install, see nodeRuntime), plus taskkill to stop it.
    expect(delegated).toContain("const command = node ? node.command : binary.path;");
    expect([...delegated.matchAll(/spawn\(/g)]).toHaveLength(2);
    const opener = readFileSync(join(root, "packages/report/src/node/open.ts"), "utf8");
    expect(opener).toContain(
      'spawn(command, [path], { detached: true, stdio: "ignore", shell: false });',
    );
    expect([...opener.matchAll(/spawn\(/g)]).toHaveLength(1);
    // The spec runner starts only a Node (nodeRuntime: this Node, or one found for the desktop app), without a shell.
    const spec = readFileSync(join(root, "packages/core/src/run/spec-run.ts"), "utf8");
    expect([...spec.matchAll(/spawn\(/g)]).toHaveLength(1);
    expect(spec).toContain("spawn(node.command, args, {");
    expect(spec).not.toMatch(/shell:\s*true|execSync|execFile|import \{[^}]*\bexec\b/);
    const bench = readFileSync(join(root, "packages/core/src/bench/fixtures.ts"), "utf8");
    expect([...bench.matchAll(/spawn\(/g)]).toHaveLength(1);
    expect(bench).toContain("spawn(node.command, args, {");
    expect(bench).toContain("shell: false,");
    expect(bench).not.toMatch(/shell:\s*true|execSync|execFile|import \{[^}]*\bexec\b/);
    // Hooks start one command (allowlisted, or psql/mysql), never through a shell.
    const hooks = readFileSync(join(root, "packages/core/src/hooks/exec.ts"), "utf8");
    expect([...hooks.matchAll(/spawn\(/g)]).toHaveLength(1);
    expect(hooks).toContain("shell: false,");
    expect(hooks).not.toMatch(/shell:\s*true|execSync|execFile|import \{[^}]*\bexec\b/);
  });

  it("lets the Android guard connect only after the allowlist, and the driver link only to loopback", () => {
    const guard = readFileSync(join(root, "packages/android/src/guard.ts"), "utf8");
    expect(guard).toContain('export const GUARD_HOST = "127.0.0.1";');
    expect([...guard.matchAll(/\.listen\(/g)]).toHaveLength(1);
    expect(guard).toMatch(/server\.listen\(0, GUARD_HOST,/);
    // The two ways out: a proxied HTTP request and a tunnel, each after its check.
    expect([...guard.matchAll(/httpRequest\(/g)]).toHaveLength(1);
    expect([...guard.matchAll(/tcpConnect\(/g)]).toHaveLength(1);
    const request = guard.slice(guard.indexOf("#onRequest(req"), guard.indexOf("httpRequest("));
    expect(request).toContain("!policy.allowlist.allowsUrl(url)");
    const tunnel = guard.slice(guard.indexOf("async #openTunnel("), guard.indexOf("tcpConnect("));
    expect(tunnel).toContain("policy.allowlist.allowsHost(");
    expect(tunnel).toContain("if (!allowed || this.#policy !== policy || client.destroyed)");
    const driver = readFileSync(join(root, "packages/android/src/driver.ts"), "utf8");
    expect(driver).toContain('export const DRIVER_HOST = "127.0.0.1";');
    expect([...driver.matchAll(/connect\(\{/g)]).toHaveLength(1);
    expect(driver).toContain("connect({ host: DRIVER_HOST, port })");
  });

  it("sends Android hook requests only after the host check", () => {
    const hooks = readFileSync(join(root, "packages/android/src/hooks.ts"), "utf8");
    const send = hooks.slice(hooks.indexOf("export async function sendHookRequest("));
    expect(
      send.indexOf("if (!hookAllowed(url, context.allowlist, context.baseUrl))"),
    ).toBeGreaterThan(0);
    expect(send.indexOf("if (!hookAllowed(")).toBeLessThan(send.indexOf("send("));
  });

  it("keeps fixtures out of engine packages (tests may use them)", () => {
    // Bench (BEN-0) is the one exception: it loads the repository's fixtures at run
    // time, through one dynamic import that says what to do when they're missing.
    const BENCH = "packages/core/src/bench/fixtures.ts";
    const packageSource = source.filter((f) => rel(f).startsWith("packages/") && rel(f) !== BENCH);
    expect(offenders(packageSource, new RegExp(`["']${brand.npmScope}/fixture-`))).toEqual([]);
    const bench = readFileSync(join(root, BENCH), "utf8");
    expect(bench).not.toMatch(new RegExp(`^import[^;]*${brand.npmScope}/fixture-`, "m"));
    expect(bench).toContain("return (await import(name)) as T;");
    const core = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8"));
    expect(Object.keys(core.dependencies).filter((d) => d.includes("/fixture-"))).toEqual([]);
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
