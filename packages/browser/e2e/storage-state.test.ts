import { readFileSync } from "node:fs";
import { launchBrowser, type LaunchedBrowser } from "@optestra/browser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readZip } from "../src/zip.js";
import { login, open, PASSWORD, secret, seed, shop } from "./helpers.js";

// Saved logins (SEC-3, AUTH-1): a session's storage state can be exported after a
// login and loaded into a fresh session, and its values are scrubbed from every
// outcome and artifact of both sessions.

let browser: LaunchedBrowser;
let running: Awaited<ReturnType<typeof shop>>;

beforeAll(async () => {
  browser = await launchBrowser();
  running = await shop();
});
afterAll(async () => {
  await running.stop();
  await browser.close();
});

describe("storage state", () => {
  it("round-trips a login into a fresh session, and no cookie value is in any output", async () => {
    await seed(running.url);
    const first = await open(running.url, {
      browser,
      secrets: { SHOP_PASSWORD: secret("SHOP_PASSWORD", PASSWORD, ["127.0.0.1"]) },
      redact: (text) => text,
    });
    await login(first);
    const state = await first.storageState();
    await first.close();
    const cookie = state.cookies.find((c) => c.name === "acme_session")?.value ?? "";
    expect(cookie.length).toBeGreaterThan(5);

    // A fresh session (after its setup, say) takes the saved login: no login page.
    const second = await open(running.url, {
      browser,
      redact: (text) => text,
      evidence: { trace: true, console: true, network: true },
    });
    const outputs: unknown[] = [];
    outputs.push(await second.act({ type: "goto", url: "/dashboard" }));
    expect(second.url).toMatch(/\/login/);
    await second.useStorageState(state);
    const opened = await second.act({ type: "goto", url: "/dashboard" });
    outputs.push(opened, await second.observe());
    expect(opened.post.urlAfter).toMatch(/\/dashboard$/);
    const closed = await second.close();
    const texts = [JSON.stringify(outputs)];
    for (const file of closed.evidence) {
      const bytes = readFileSync(file.path);
      if (file.path.endsWith(".zip"))
        for (const entry of readZip(bytes)) texts.push(Buffer.from(entry.data).toString("latin1"));
      else texts.push(bytes.toString("utf8"));
    }
    const joined = texts.join("\n");
    // The request cookie is in the HAR and trace, scrubbed.
    expect(joined).toContain("acme_session=[session]");
    expect(joined).not.toContain(`acme_session=${cookie}`);
    expect(joined).not.toMatch(new RegExp(`[^a-z0-9-]${cookie}[^0-9]`));
  });
});
