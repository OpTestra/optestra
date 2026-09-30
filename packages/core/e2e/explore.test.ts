import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type LaunchedBrowser, launchBrowser, openSession } from "@testament/browser";
import type { ScriptedCall, ScriptedReply } from "@testament/models/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promptText, refIn, scriptedModels } from "../src/author/test-kit.test-support.js";
import { exploreApp } from "../src/explore/explore.js";

// Explore (EXPL-1) with a scripted model on a tiny site with planted problems: a
// console error on the home page, a broken link, and a page that fails on
// the server. Code finds them (not the model), with evidence; the server error
// gets a proposed regression test; the dead end is reported. Nothing is saved.

const page = (title: string, body: string, status = 200) => ({ status, title, body });
const PAGES: Record<string, { status: number; title: string; body: string }> = {
  "/": page(
    "Tiny shop",
    `<h1>Tiny shop</h1><nav><a href="/pricing">Pricing</a> <a href="/old-offer">Old offer</a></nav>
     <script>console.error("price feed failed: 502")</script>`,
  ),
  "/pricing": page("Pricing", `<h1>Pricing</h1><p>Pro $29</p><a href="/continue">Continue</a>`),
  "/continue": page("Error", "<h1>Something went wrong</h1><p>Please try again later.</p>", 500),
};

let server: Server;
let base: string;
let browser: LaunchedBrowser;
beforeAll(async () => {
  server = createServer((req, res) => {
    const found = PAGES[req.url ?? "/"];
    const { status, title, body } = found ?? page("Not found", "<h1>Page not found</h1>", 404);
    res.writeHead(status, { "content-type": "text/html" });
    res.end(`<!doctype html><title>${title}</title>${body}`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser.close();
  await new Promise((done) => server.close(done));
});

function explorer() {
  return (call: ScriptedCall): ScriptedReply => {
    const text = promptText(call);
    const draft = /The test so far:\n([\s\S]*?)\n\nWhat happened so far:/.exec(text)?.[1] ?? "";
    const heading = /heading "([^"]+)"/.exec(text.split("Current page:")[1] ?? "")?.[1];
    if (heading === "Tiny shop")
      return { toolCalls: [{ name: "click", input: { ref: refIn(text, "link", "Pricing") } }] };
    if (heading === "Pricing" && !draft.includes("Expect"))
      return { toolCalls: [{ name: "expect", input: { text: 'the page heading is "Pricing"' } }] };
    if (heading === "Pricing")
      return { toolCalls: [{ name: "click", input: { ref: refIn(text, "link", "Continue") } }] };
    return {
      toolCalls: [{ name: "draft_impossible", input: { reason: "the next page shows an error" } }],
    };
  };
}

describe("exploreApp (scripted model)", () => {
  it("finds the console error, the broken link and the server error, proposes a test, reports the dead end", async () => {
    const session = await openSession({
      browser,
      baseUrl: base,
      allowedDomains: ["127.0.0.1"],
      evidence: { trace: false, console: false, network: false, video: false },
    });
    const { models, calls } = scriptedModels(explorer());
    try {
      const result = await exploreApp("a visitor can buy the Pro plan", { session, models });
      const kinds = result.findings.map((f) => f.kind);
      expect(kinds).toEqual(
        expect.arrayContaining(["console_error", "broken_link", "server_error", "dead_end"]),
      );
      const consoleError = result.findings.find((f) => f.kind === "console_error");
      expect(consoleError?.evidence[0]).toContain("price feed failed: 502");
      expect(consoleError?.route).toBe("/");
      const broken = result.findings.find((f) => f.kind === "broken_link");
      expect(broken?.summary).toBe(
        'The link "Old offer" on / leads to /old-offer, which answered 404',
      );
      const server = result.findings.find((f) => f.kind === "server_error");
      expect(server?.summary).toContain('/continue answered 500 ("Something went wrong")');
      expect(result.findings.find((f) => f.kind === "dead_end")?.summary).toContain(
        "the next page shows an error",
      );
      // The way there, and a regression test for the server error (it fails until fixed).
      expect(result.draft.status).toBe("impossible");
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]?.text).toBe(`---
name: No error after clicking "Continue"
start: /
---

1. Click "Pricing"
2. Click "Continue"
3. Expect: the page doesn't show "Something went wrong"
`);
      expect(result.proposals[0]?.lintClean).toBe(true);
      expect(server?.proposal?.path).toBe(result.proposals[0]?.path);
      expect(result.linksChecked).toBe(3);
      expect(result.promptVersion).toBe("explorer-v1");
      expect(calls.map(promptText).join("\n")).toContain("findings so far");
      expect(result.modelCalls).toHaveLength(calls.length);
    } finally {
      await session.close();
    }
  });
});
