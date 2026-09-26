import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser, type LaunchedBrowser, type Session } from "@testament/browser";
import {
  eventually,
  find,
  type Hostile,
  hostile,
  login,
  open,
  PASSWORD,
  seed,
  shop,
} from "./helpers.js";

// Guarantee 1 (SAF-1): the allowlist is enforced by the browser layer.

let browser: LaunchedBrowser;
let evil: Hostile;
let session: Session;

beforeAll(async () => {
  browser = await launchBrowser();
  evil = await hostile();
});
afterAll(async () => {
  await session?.close();
  await evil.stop();
  await browser.close();
});

const fresh = async () => {
  await session?.close();
  session = await open(evil.url, { browser });
  evil.hits.length = 0;
  return session;
};
const reachedOther = () => evil.hits.filter((hit) => hit.startsWith("localhost"));

describe("network guard", () => {
  it("refuses a goto to a host outside the allowlist without sending anything", async () => {
    const s = await fresh();
    const outcome = await s.act({ type: "goto", url: `${evil.other}/` });
    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toBe("disallowed_domain");
    expect(outcome.post.refused).toMatchObject([{ type: "navigation", url: `${evil.other}/` }]);
    expect(reachedOther()).toEqual([]);
  });

  it("refuses a link that navigates the page to another host", async () => {
    const s = await fresh();
    await s.act({ type: "goto", url: "/links" });
    const page = await s.observe();
    const outcome = await s.act({
      type: "click",
      target: { ref: find(page, "link", "Leave").ref },
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toBe("disallowed_domain");
    expect(outcome.post.refused.map((r) => r.type)).toContain("navigation");
    expect(s.url).toBe(`${evil.url}/links`);
    expect(reachedOther()).toEqual([]);
  });

  it("refuses a redirect from an allowed host to another host", async () => {
    const s = await fresh();
    const outcome = await s.act({ type: "goto", url: "/redirect" });
    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toBe("disallowed_domain");
    expect(s.url.startsWith(evil.other)).toBe(false);
    // Chromium's network stack sends it to the refusing proxy, never to the host.
    expect(reachedOther()).toEqual([]);
  });

  it("refuses a popup to another host and closes it", async () => {
    const s = await fresh();
    await s.act({ type: "goto", url: "/links" });
    const page = await s.observe();
    const outcome = await s.act({
      type: "click",
      target: { ref: find(page, "link", "Popup").ref },
    });
    await eventually(() => s.refusals().some((r) => r.type === "popup"));
    expect(s.refusals().find((r) => r.type === "popup")?.url).toBe(`${evil.other}/popup`);
    expect(s.url).toBe(`${evil.url}/links`);
    expect(outcome.post.popups.filter((url) => url.startsWith(evil.other))).toEqual([]);
    expect(reachedOther()).toEqual([]);
  });

  it("refuses an iframe from another host but keeps the page", async () => {
    const s = await fresh();
    const outcome = await s.act({ type: "goto", url: "/frame" });
    expect(outcome.status).toBe("ok");
    expect(outcome.post.refused).toMatchObject([{ type: "iframe", url: `${evil.other}/framed` }]);
    expect(reachedOther()).toEqual([]);
  });

  it("refuses fetch to another host (recorded, the test goes on)", async () => {
    const s = await fresh();
    const outcome = await s.act({ type: "goto", url: "/fetch" });
    expect(outcome.status).toBe("ok");
    await eventually(async () => (await s.observe()).title === "blocked");
    expect(s.refusals()).toMatchObject([
      { type: "fetch", url: `${evil.other}/exfiltrate`, frame: `${evil.url}/fetch` },
    ]);
    expect(reachedOther()).toEqual([]);
  });

  it("refuses a socket to another host", async () => {
    const s = await fresh();
    await s.act({ type: "goto", url: "/socket" });
    await eventually(() => s.refusals().some((r) => r.type === "websocket"));
    expect(s.refusals().find((r) => r.type === "websocket")?.url).toBe(
      `${evil.other.replace("http", "ws")}/ws`,
    );
    await eventually(async () => (await s.observe()).title === "closed");
    expect(reachedOther()).toEqual([]);
  });

  it("blocks service workers", async () => {
    const s = await fresh();
    await s.act({ type: "goto", url: "/worker" });
    await eventually(async () => (await s.observe()).title !== "Hostile");
    // Registration never happens: the worker script is not even fetched.
    expect((await s.observe()).title).not.toBe("registered");
    expect(evil.hits).not.toContain(`127.0.0.1:${evil.port}/sw.js`);
  });

  it("refuses downloads", async () => {
    const s = await fresh();
    await s.act({ type: "goto", url: "/links" });
    const page = await s.observe();
    await s.act({ type: "click", target: { ref: find(page, "link", "Download").ref } });
    await eventually(() => s.refusals().some((r) => r.type === "download"));
    expect(s.refusals().find((r) => r.type === "download")?.url).toBe(`${evil.url}/file.txt`);
  });

  it("refuses data: and file: pages, from goto and from the page itself", async () => {
    const s = await fresh();
    for (const url of [
      "data:text/html,<h1>hi</h1>",
      "file:///etc/hosts",
      "javascript:alert(1)",
      "blob:http://127.0.0.1/x",
    ]) {
      const outcome = await s.act({ type: "goto", url });
      expect(outcome.status, url).toBe("refused");
      expect(outcome.reason, url).toBe("disallowed_domain");
      expect(outcome.post.refused, url).toMatchObject([{ type: "scheme" }]);
    }
    expect((await s.act({ type: "goto", url: "about:blank" })).status).toBe("ok");
    await s.act({ type: "goto", url: "/links" });
    for (const name of ["Data page", "File page"]) {
      const page = await s.observe();
      await s.act({ type: "click", target: { ref: find(page, "button", name).ref } });
      expect(s.url.startsWith("data:") || s.url.startsWith("file:"), name).toBe(false);
    }
  });

  it("isolates sessions: nothing is shared between contexts", async () => {
    const running = await shop();
    try {
      await seed(running.url);
      const a = await open(running.url, { browser });
      await login(a, PASSWORD);
      const b = await open(running.url, { browser });
      await b.act({ type: "goto", url: "/dashboard" });
      // a is logged in; b gets none of its cookies or storage and is sent to log in.
      expect(b.url).toContain("/login");
      await a.close();
      await b.close();
    } finally {
      await running.stop();
    }
  });
});
