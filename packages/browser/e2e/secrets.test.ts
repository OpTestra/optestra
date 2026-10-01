import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asDynamicSecret, Redactor } from "@optestra/config/node";
import {
  type ActionOutcome,
  launchBrowser,
  type LaunchedBrowser,
  renderForModel,
} from "@optestra/browser";
import { readZip } from "../src/zip.js";
import { find, hostile, open, PASSWORD, secret, seed, shop } from "./helpers.js";

// Guarantee 3 (SEC-1, SEC-2, SEC-6): secrets are typed, never seen.

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

describe("secrets", () => {
  it("types a secret on its own domain, and the value is in no output or artifact", async () => {
    await seed(running.url);
    // A redactor the session was NOT given: the session must still scrub with its own.
    const shopPassword = secret("SHOP_PASSWORD", PASSWORD, ["127.0.0.1"], new Redactor());
    const session = await open(running.url, {
      browser,
      secrets: { SHOP_PASSWORD: shopPassword },
      redact: (text) => text,
      evidence: { trace: true, video: true, console: true, network: true },
    });
    const outputs: unknown[] = [];
    const act = async (action: Parameters<typeof session.act>[0]): Promise<ActionOutcome> => {
      const outcome = await session.act(action);
      outputs.push(outcome);
      return outcome;
    };

    await act({ type: "goto", url: "/login" });
    let page = await session.observe();
    await act({
      type: "fill",
      target: { ref: find(page, "textbox", "Email").ref },
      value: "ada@example.com",
    });
    const filled = await act({
      type: "fill",
      target: { ref: find(page, "textbox", "Password").ref },
      value: { secret: "SHOP_PASSWORD" },
    });
    expect(filled.status).toBe("ok");
    expect(filled.action).toEqual({
      type: "fill",
      target: { ref: find(page, "textbox", "Password").ref },
      value: { secret: "SHOP_PASSWORD" },
    });
    // The field holds the value, and the observation shows only the label.
    page = await session.observe();
    outputs.push(page, renderForModel(page));
    expect(find(page, "textbox", "Password").text).toBe("[secret:SHOP_PASSWORD]");
    const loggedIn = await act({
      type: "click",
      target: { ref: find(page, "button", "Log in").ref },
    });
    expect(loggedIn.post.urlAfter).toContain("/dashboard");
    outputs.push(await session.observe(), await session.candidates("e1"), session.refusals());
    const shot = await session.screenshot({ forModel: true });
    expect(shot.status).toBe("ok");

    const closed = await session.close();
    outputs.push(closed);
    expect(closed.evidence.map((file) => file.kind).sort()).toEqual([
      "console",
      "network",
      "trace",
      "video",
    ]);
    expect(closed.evidence.every((file) => file.scrubbed)).toBe(true);

    const leaks: string[] = [];
    const check = (where: string, text: string) => {
      if (text.includes(PASSWORD)) leaks.push(where);
    };
    check("outputs", JSON.stringify(outputs));
    for (const file of closed.evidence) {
      const bytes = readFileSync(file.path);
      if (file.kind === "video") continue; // pixels: password fields are drawn masked
      check(file.kind, bytes.toString("latin1"));
      if (file.kind === "trace") {
        const entries = readZip(bytes);
        expect(entries.some((e) => /trace\.trace$/.test(e.name))).toBe(true);
        for (const entry of entries)
          check(`trace:${entry.name}`, Buffer.from(entry.data).toString("utf8"));
      }
    }
    // Request bodies are dropped from the network log (SEC-6); the login POST is still listed.
    const har = JSON.parse(
      readFileSync(closed.evidence.find((f) => f.kind === "network")?.path ?? "", "utf8"),
    );
    const post = har.log.entries.find(
      (e: { request: { method: string; url: string } }) =>
        e.request.method === "POST" && e.request.url.endsWith("/login"),
    );
    expect(post).toBeDefined();
    expect(post.request.postData).toBeUndefined();
    expect(leaks).toEqual([]);
  });

  it("scrubs a secret the page itself logs to the console", async () => {
    const evil = await hostile();
    try {
      const session = await open(evil.url, {
        browser,
        secrets: { EVIL: secret("EVIL", "planted-value-9071", ["127.0.0.1"]) },
        evidence: { console: true, trace: true },
      });
      await session.act({ type: "goto", url: "/console" });
      const page = await session.observe();
      const filled = await session.act({
        type: "fill",
        target: { ref: find(page, "textbox", "Secret field").ref },
        value: { secret: "EVIL" },
      });
      expect(filled.status).toBe("ok");
      const closed = await session.close();
      const log = readFileSync(
        closed.evidence.find((f) => f.kind === "console")?.path ?? "",
        "utf8",
      );
      expect(log).toContain("typed: [secret:EVIL]");
      expect(log).not.toContain("planted-value-9071");
      const trace = readZip(
        readFileSync(closed.evidence.find((f) => f.kind === "trace")?.path ?? ""),
      );
      for (const entry of trace) {
        expect(Buffer.from(entry.data).toString("utf8"), entry.name).not.toContain(
          "planted-value-9071",
        );
      }
    } finally {
      await evil.stop();
    }
  });

  it("refuses a secret on a domain it isn't tied to (Blocked: disallowed_domain)", async () => {
    await seed(running.url);
    const session = await open(running.url, {
      browser,
      secrets: { SHOP_PASSWORD: secret("SHOP_PASSWORD", PASSWORD, ["shop.example.com"]) },
    });
    await session.act({ type: "goto", url: "/login" });
    const page = await session.observe();
    const outcome = await session.act({
      type: "fill",
      target: { ref: find(page, "textbox", "Password").ref },
      value: { secret: "SHOP_PASSWORD" },
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toBe("disallowed_domain");
    expect(outcome.message).toContain("127.0.0.1");
    expect(find(await session.observe(), "textbox", "Password").text).toBeUndefined();
    await session.close();
  });

  it("types a dynamic secret's value produced at the moment of the fill (TOTP, AUTH-0)", async () => {
    const evil = await hostile();
    try {
      let produced = 0;
      const dynamic = asDynamicSecret(
        secret("OTP", "seed-value-5150", ["127.0.0.1"]),
        "test",
        async (stored) => `${stored.slice(0, 4)}-code-${++produced}`,
        new Redactor(), // not the session's: the session must scrub the code itself
      );
      const session = await open(evil.url, {
        browser,
        secrets: { OTP: dynamic },
        redact: (text) => text,
        evidence: { console: true },
      });
      expect(produced).toBe(0); // nothing is produced when the session opens
      await session.act({ type: "goto", url: "/console" });
      const page = await session.observe();
      const filled = await session.act({
        type: "fill",
        target: { ref: find(page, "textbox", "Secret field").ref },
        value: { secret: "OTP" },
      });
      expect(filled.status).toBe("ok");
      expect(produced).toBe(1);
      const closed = await session.close();
      const log = readFileSync(
        closed.evidence.find((f) => f.kind === "console")?.path ?? "",
        "utf8",
      );
      // The page logged what was typed: the produced code, scrubbed to the label.
      expect(log).toContain("typed: [secret:OTP]");
      expect(log).not.toContain("seed-code-1");
      expect(log).not.toContain("seed-value-5150");
    } finally {
      await evil.stop();
    }
  });

  it("refuses a secret that wasn't provided (Blocked: missing_secret)", async () => {
    const session = await open(running.url, { browser });
    await session.act({ type: "goto", url: "/login" });
    const page = await session.observe();
    const outcome = await session.act({
      type: "fill",
      target: { ref: find(page, "textbox", "Password").ref },
      value: { secret: "NOT_THERE" },
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.reason).toBe("missing_secret");
    await session.close();
  });
});
