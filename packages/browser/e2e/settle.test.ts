import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { find, open } from "./helpers.js";

// Settle and request status around a click whose request starts a little after
// the click returns (FIX-1). The page is idle for longer than the quiet window
// first, so only the action's own request can keep settle waiting.

const QUIET_MS = 300;
const SLOW_MS = 600;

let server: Server;
let base = "";

const page = (script: string) => `<!doctype html><html><head><title>Settle</title></head><body>
<h1>Settle</h1><button id="go">Go</button><p id="out"></p>
<script>
document.getElementById("go").addEventListener("click", () => {
  setTimeout(() => {
    ${script}
      .then((r) => { document.getElementById("out").textContent = "status " + r.status; },
            () => { document.getElementById("out").textContent = "failed"; });
  }, 50);
});
</script></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(body);
    if (path === "/late") return html(page(`fetch("/api/slow", { method: "POST", body: "x" })`));
    if (path === "/stuck") return html(page(`fetch("/api/hang")`));
    if (path === "/broken") return html(page(`fetch("/api/drop")`));
    if (path === "/api/slow") {
      req.resume();
      setTimeout(
        () => res.writeHead(200, { "content-type": "application/json" }).end("{}"),
        SLOW_MS,
      );
      return;
    }
    if (path === "/api/hang") return; // never answers
    if (path === "/api/drop") return req.socket.destroy();
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function clickGo(path: string, timeoutMs = 10_000) {
  const s = await open(base, { settle: { quietMs: QUIET_MS, timeoutMs } });
  await s.act({ type: "goto", url: path });
  const observed = await s.observe();
  await sleep(QUIET_MS + 200);
  const outcome = await s.act({
    type: "click",
    target: { ref: find(observed, "button", "Go").ref },
  });
  return { s, outcome };
}

describe("settle after an action (FIX-1)", () => {
  it("waits for a request the action starts after it returns", async () => {
    const { s, outcome } = await clickGo("/late");
    const text = JSON.stringify(outcome);
    expect(outcome.status, text).toBe("ok");
    expect(outcome.settle.timedOut, text).toBe(false);
    expect(outcome.settledMs, text).toBeGreaterThanOrEqual(SLOW_MS);
    expect(outcome.settledMs, text).toBe(outcome.settle.settledMs);
    expect(outcome.post.requests, text).toContainEqual(
      expect.objectContaining({ method: "POST", url: `${base}/api/slow`, status: 200 }),
    );
    expect(outcome.post.added.map((e) => e.text).join(" "), text).toContain("status 200");
    await s.close();
  });

  it("reports a request still running at the timeout as pending, not failed", async () => {
    const { s, outcome } = await clickGo("/stuck", 1_000);
    const text = JSON.stringify(outcome);
    expect(outcome.settle, text).toMatchObject({ timedOut: true, inflight: 1 });
    expect(outcome.settledMs, text).toBeGreaterThanOrEqual(1_000);
    expect(outcome.post.requests, text).toContainEqual(
      expect.objectContaining({ url: `${base}/api/hang`, status: "pending" }),
    );
    await s.close();
  });

  it("marks a request that really failed as failed, with Playwright's reason", async () => {
    const { s, outcome } = await clickGo("/broken");
    const text = JSON.stringify(outcome);
    expect(outcome.settle.timedOut, text).toBe(false);
    const request = outcome.post.requests.find((r) => r.url === `${base}/api/drop`);
    expect(request, text).toMatchObject({ status: "failed", failure: expect.any(String) });
    expect(request?.failure, text).not.toBe("");
    await s.close();
  });
});
