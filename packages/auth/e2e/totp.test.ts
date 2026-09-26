import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { memorySource, Redactor, resolveSecrets } from "@testament/config/node";
import { launchBrowser, type LaunchedBrowser, openSession } from "@testament/browser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTotpSeed, verifyTotp } from "@testament/auth";
import { readZip } from "../../browser/src/zip.js";

// SEC-4 in a real browser: a TOTP secret types the current code on its allowed host
// (the server checks it against the same seed), and is refused on another host.
// `localhost` is the other host: same server, not one of the secret's domains.

const SEED = "otpauth://totp/Acme:ada?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Acme";

let browser: LaunchedBrowser;
let server: Server;
let base = "";
let other = "";
const posted: string[] = [];

beforeAll(async () => {
  browser = await launchBrowser();
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method === "POST") {
        posted.push(new URLSearchParams(body).get("otp") ?? "");
        res.writeHead(200, { "content-type": "text/html" }).end("<h1>Checked</h1>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>2FA</title>
<form method="post" action="/otp"><label>Authentication code <input name="otp" autocomplete="one-time-code"></label>
<button>Verify</button></form>`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  other = `http://localhost:${port}`;
});
afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

function totpSecret(redactor: Redactor) {
  const config = {
    secrets: { ADMIN_TOTP: { domains: ["127.0.0.1"], type: "totp" } },
    auth: { profiles: {}, totp: { minRemainingSeconds: 5 } },
  } as never;
  const { secrets, diagnostics } = resolveSecrets(config, [
    memorySource({ ADMIN_TOTP: SEED }, {}, { redactor }),
  ]);
  expect(diagnostics).toEqual([]);
  if (!secrets.ADMIN_TOTP) throw new Error("no secret");
  return secrets.ADMIN_TOTP;
}

describe("TOTP secrets in the browser", () => {
  it("types a code that validates against the same seed, and it is in no output", async () => {
    const redactor = new Redactor();
    const session = await openSession({
      browser,
      baseUrl: base,
      allowedDomains: ["127.0.0.1"],
      secrets: { ADMIN_TOTP: totpSecret(redactor) },
      redact: (text) => text, // the session must still scrub the code with its own redactor
      evidence: { console: true, network: true, trace: true },
    });
    await session.act({ type: "goto", url: "/otp" });
    const page = await session.observe();
    const field = page.elements.find((e) => e.role === "textbox")?.ref ?? "";
    const filled = await session.act({
      type: "fill",
      target: { ref: field },
      value: { secret: "ADMIN_TOTP" },
    });
    expect(filled.status).toBe("ok");
    const typedAt = Date.now();
    const after = await session.observe();
    expect(after.elements.find((e) => e.ref === field)?.text).toBe("[secret:ADMIN_TOTP]");
    const button = after.elements.find((e) => e.role === "button")?.ref ?? "";
    await session.act({ type: "click", target: { ref: button } });
    const closed = await session.close();

    const code = posted.at(-1) ?? "";
    expect(code).toMatch(/^\d{6}$/);
    const parsed = parseTotpSeed(SEED);
    if (!parsed.ok) throw new Error("seed");
    expect(verifyTotp(parsed.seed, code, typedAt)).toBe(true);
    const text = JSON.stringify([filled, after, closed]);
    expect(text).not.toContain(code);
    for (const file of closed.evidence) {
      const bytes = readFileSync(file.path);
      if (file.kind !== "trace") {
        expect(bytes.toString("utf8"), file.kind).not.toContain(code);
        continue;
      }
      for (const entry of readZip(bytes)) {
        if (/\.(jpe?g|png)$/.test(entry.name)) continue; // pixels
        expect(Buffer.from(entry.data).toString("utf8"), entry.name).not.toContain(code);
      }
    }
  });

  it("refuses to type it on a host that isn't one of its domains", async () => {
    const before = posted.length;
    const session = await openSession({
      browser,
      baseUrl: other,
      allowedDomains: ["127.0.0.1", "localhost"],
      secrets: { ADMIN_TOTP: totpSecret(new Redactor()) },
    });
    await session.act({ type: "goto", url: "/otp" });
    const page = await session.observe();
    const outcome = await session.act({
      type: "fill",
      target: { ref: page.elements.find((e) => e.role === "textbox")?.ref ?? "" },
      value: { secret: "ADMIN_TOTP" },
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toBe("disallowed_domain");
    expect(outcome.message).toContain("localhost");
    await session.close();
    expect(posted.length).toBe(before);
  });
});
