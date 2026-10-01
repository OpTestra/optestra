import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type LaunchedBrowser, launchBrowser } from "@optestra/browser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventually, open, secret } from "./helpers.js";

// SEC-8: protected-preview headers go only to allowed hosts in their secret's
// domains. `localhost` is the same server under a second name: allowed in one
// test, outside the allowlist in the other, never in the secret's domains.

const TOKEN = "vercel-bypass-3f9a1c77";
const USER = "preview-user";
const PASS = "preview-pass-8812";

let browser: LaunchedBrowser;
let server: Server;
let base = "";
let other = "";
const seen: { host: string; path: string; headers: IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  browser = await launchBrowser();
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    seen.push({ host: req.headers.host ?? "", path, headers: req.headers });
    const html = (body: string) =>
      `<!doctype html><html><head><title>Preview</title></head><body>${body}</body></html>`;
    if (path === "/")
      res.writeHead(200, { "content-type": "text/html" }).end(
        html(`<h1>Preview</h1>
<img alt="same host" src="/pixel.gif">
<img alt="other host" src="${other}/pixel.gif">
<script>
fetch("/api/own", { headers: { authorization: "Bearer app-token" } });
fetch("${other}/api/cross").catch(() => {});
</script>`),
      );
    else
      res
        .writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" })
        .end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  other = `http://localhost:${port}`;
});
afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const secrets = () => ({
  BYPASS: secret("BYPASS", TOKEN, ["127.0.0.1"]),
  PREVIEW_USER: secret("PREVIEW_USER", USER, ["127.0.0.1"]),
  PREVIEW_PASSWORD: secret("PREVIEW_PASSWORD", PASS, ["127.0.0.1"]),
});
const basic = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
const on = (host: string) => seen.filter((hit) => hit.host.startsWith(host));

describe("protected-preview headers", () => {
  it("are sent to the allowed host in the secret's domains, and nowhere else", async () => {
    seen.length = 0;
    const session = await open(base, {
      browser,
      allowedDomains: ["127.0.0.1", "localhost"],
      secrets: secrets(),
      protectedHeaders: [
        { name: "x-vercel-protection-bypass", secret: "BYPASS" },
        {
          name: "Authorization",
          basic: { username: "PREVIEW_USER", password: "PREVIEW_PASSWORD" },
        },
      ],
      evidence: { network: true, console: true },
    });
    await session.act({ type: "goto", url: "/" });
    await eventually(
      () => on("localhost").length >= 2 && on("127.0.0.1").some((h) => h.path === "/api/own"),
    );
    expect(
      on("localhost")
        .map((h) => h.path)
        .sort(),
    ).toEqual(["/api/cross", "/pixel.gif"]);
    const own = on("127.0.0.1");
    for (const hit of own) expect(hit.headers["x-vercel-protection-bypass"]).toBe(TOKEN);
    expect(own.find((h) => h.path === "/")?.headers.authorization).toBe(basic);
    // The app's own Authorization header wins over basic auth.
    expect(own.find((h) => h.path === "/api/own")?.headers.authorization).toBe("Bearer app-token");
    for (const hit of on("localhost")) {
      expect(hit.headers["x-vercel-protection-bypass"]).toBeUndefined();
      expect(hit.headers.authorization).toBeUndefined();
    }

    // Setup hooks get them too, with the same scoping.
    await session.hookRequest({ method: "POST", target: "/seed" });
    await session.hookRequest({ method: "POST", target: `${other}/seed` });
    expect(on("127.0.0.1").at(-1)?.headers["x-vercel-protection-bypass"]).toBe(TOKEN);
    expect(on("localhost").at(-1)?.headers["x-vercel-protection-bypass"]).toBeUndefined();

    const { evidence } = await session.close();
    const har = evidence.find((file) => file.kind === "network");
    expect(har).toBeDefined();
    const text = readFileSync(har?.path as string, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PASS);
    expect(text).not.toContain(basic.slice(6));
  });

  it("never reach a host outside the allowlist", async () => {
    seen.length = 0;
    const session = await open(base, {
      browser,
      allowedDomains: ["127.0.0.1"],
      // Even a secret that claims every domain is sent only where the allowlist allows.
      secrets: { BYPASS: secret("BYPASS", TOKEN, ["127.0.0.1", "localhost"]) },
      protectedHeaders: [{ name: "x-vercel-protection-bypass", secret: "BYPASS" }],
    });
    await session.act({ type: "goto", url: "/" });
    await eventually(() => on("127.0.0.1").some((h) => h.path === "/api/own"));
    expect(on("localhost")).toEqual([]);
    await session.close();
  });

  it("fail the session setup when a secret has no value", async () => {
    await expect(
      open(base, {
        browser,
        protectedHeaders: [{ name: "x-vercel-protection-bypass", secret: "BYPASS" }],
      }),
    ).rejects.toThrow(/needs secret BYPASS/);
  });
});
