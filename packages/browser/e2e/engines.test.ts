import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserName } from "@testament/browser";
import { find, open, shop } from "./helpers.js";

// A basic run on Firefox and WebKit proves the launch path (TGT-3). Chromium is
// covered by every other file. BROWSER_ENGINES narrows the list (e.g. "webkit").

const engines = (process.env.BROWSER_ENGINES ?? "firefox,webkit")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean) as BrowserName[];

let running: Awaited<ReturnType<typeof shop>>;
beforeAll(async () => {
  running = await shop();
});
afterAll(async () => {
  await running.stop();
});

describe.each(engines)("%s", (engine) => {
  it("opens, observes, acts and enforces the allowlist", async () => {
    const session = await open(running.url, {
      browser: engine,
      device: "laptop",
      evidence: { trace: true },
    });
    expect(session.browserName).toBe(engine);
    expect((await session.act({ type: "goto", url: "/pricing" })).status).toBe("ok");
    const page = await session.observe();
    expect(find(page, "heading", "Pricing")).toBeDefined();
    const click = await session.act({
      type: "click",
      target: { ref: find(page, "link", "Log in").ref },
    });
    expect(click.post.urlAfter).toBe(`${running.url}/login`);
    const away = await session.act({
      type: "goto",
      url: `http://localhost:${running.port}/pricing`,
    });
    expect(away).toMatchObject({ status: "refused", reason: "disallowed_domain" });
    expect((await session.screenshot({ forModel: true })).status).toBe("ok");
    const closed = await session.close();
    expect(closed.evidence.map((f) => f.kind)).toEqual(["trace"]);
  });

  it("emulates a phone preset", async () => {
    const session = await open(running.url, { browser: engine, device: "pixel-8" });
    await session.act({ type: "goto", url: "/pricing" });
    const shot = await session.screenshot();
    expect(Buffer.from(shot.bytes).readUInt32BE(16)).toBeLessThan(1280);
    await session.close();
  });
});
