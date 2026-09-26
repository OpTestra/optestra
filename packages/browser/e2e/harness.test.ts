import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  launchBrowser,
  type LaunchedBrowser,
  renderForModel,
  type Session,
} from "@testament/browser";
import { find, hostile, login, open, PASSWORD, seed, shop } from "./helpers.js";

// Observation, candidates, actions with post-state, settle and screenshots,
// against the demo shop.

let browser: LaunchedBrowser;
let correct: Awaited<ReturnType<typeof shop>>;
let session: Session;

beforeAll(async () => {
  browser = await launchBrowser();
  correct = await shop("correct");
  await seed(correct.url, { trial: "pro", projects: ["Apollo"] });
  session = await open(correct.url, { browser });
  await login(session, PASSWORD);
});
afterAll(async () => {
  await session.close();
  await correct.stop();
  await browser.close();
});

const SHOP_FILES = fileURLToPath(
  new URL("../../../bench/fixtures/shop/tests/files/", import.meta.url),
);

describe("observation (MOD-3)", () => {
  const pages: Array<[string, string]> = [
    ["/", "Acme Shop"],
    ["/pricing", "Pricing"],
    ["/dashboard", "Dashboard"],
    ["/checkout?plan=pro", "Start your Pro trial"],
    ["/billing", "Billing"],
    ["/settings", "Settings"],
    ["/orders", "Orders"],
    ["/error", "Something went wrong"],
  ];

  it.each(pages)(
    "observes %s with a heading, landmarks and refs for every control",
    async (path, heading) => {
      const opened = await session.act({ type: "goto", url: path });
      expect(opened.status).toBe("ok");
      const page = await session.observe();
      expect(page.untrusted).toBe(true);
      expect(page.elements.some((e) => e.role === "heading" && e.name.includes(heading))).toBe(
        true,
      );
      expect(page.elements.some((e) => e.role === "main")).toBe(true);
      const controls = page.elements.filter((e) =>
        ["button", "link", "textbox", "combobox", "checkbox"].includes(e.role),
      );
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls)
        expect(control.ref, `${control.role} ${control.name}`).toMatch(/^e\d+$/);
      expect(renderForModel(page)).toContain(`url: "${correct.url}${path}"`);
    },
  );

  it("observes signed-out pages too", async () => {
    const guest = await open(correct.url, { browser });
    for (const [path, heading] of [
      ["/signup", "Create your account"],
      ["/login", "Log in"],
    ] as const) {
      await guest.act({ type: "goto", url: path });
      const page = await guest.observe();
      expect(
        page.elements.some((e) => e.role === "heading" && e.name === heading),
        path,
      ).toBe(true);
    }
    await guest.close();
  });

  it("sees the card fields inside the checkout iframe, with refs that work", async () => {
    await session.act({ type: "goto", url: "/checkout?plan=pro" });
    const page = await session.observe();
    const frame = find(page, "iframe", "Secure card payment");
    expect(page.frames[1]).toEqual({ url: `${correct.url}/pay/frame`, parentRef: frame.ref });
    const card = find(page, "textbox", "Card number");
    expect(card.frame).toBe(1);
    const filled = await session.act({
      type: "fill",
      target: { ref: card.ref },
      value: "4242 4242 4242 4242",
    });
    expect(filled.status).toBe("ok");
    expect(find(await session.observe(), "textbox", "Card number").text).toBe(
      "4242 4242 4242 4242",
    );

    const again = await session.observe();
    const result = await session.candidates(find(again, "textbox", "Card number").ref);
    expect(result.status).toBe("ok");
    expect(result.candidates[0]).toEqual({
      locator: {
        kind: "role",
        role: "textbox",
        name: "Card number",
        exact: true,
        frame: [{ kind: "title", text: "Secure card payment", exact: true }],
      },
      unique: true,
      matches: 1,
    });
    expect(result.facts).toMatchObject({ tag: "input", framePath: [{ kind: "title" }] });
    expect(result.facts?.box?.width).toBeGreaterThan(0);
    // A locator candidate is a valid target too.
    const byLocator = await session.act({
      type: "fill",
      target: result.candidates[0]?.locator ?? { kind: "css", selector: "x" },
      value: "4000 0000 0000 0002",
    });
    expect(byLocator.status).toBe("ok");
  });

  it("falls back to text, then CSS, for the div-button with no role", async () => {
    await session.act({ type: "goto", url: "/orders" });
    const page = await session.observe();
    const div = page.elements.find((e) => e.text === "Show refunded orders");
    expect(div).toMatchObject({ role: "generic", interactive: true });
    const result = await session.candidates(div?.ref ?? "");
    expect(result.candidates.map((c) => c.locator.kind)).toEqual(["text", "css"]);
    expect(result.candidates[0]).toMatchObject({
      locator: { kind: "text", text: "Show refunded orders", exact: true },
      unique: true,
    });
    expect(result.candidates.at(-1)?.unique).toBe(true);
    expect(result.facts).toMatchObject({ role: "generic", tag: "div", anchorText: "Orders" });
    const before = page.elements.filter((e) => e.role === "row").length;
    const clicked = await session.act({
      type: "click",
      target: result.candidates[0]?.locator ?? { ref: "" },
    });
    expect(clicked.status).toBe("ok");
    expect(clicked.post.changed).toBe(true);
    expect(
      (await session.observe()).elements.filter((e) => e.role === "rowheader").length,
    ).toBeGreaterThan(before);
  });

  it("refs from an older observation stop working", async () => {
    await session.act({ type: "goto", url: "/pricing" });
    const first = await session.observe();
    await session.act({ type: "goto", url: "/billing" });
    await session.observe();
    const stale = find(first, "button", /Start free trial/).ref;
    const outcome = await session.act({ type: "click", target: { ref: `${stale}9999` } });
    expect(outcome.status).toBe("not_found");
  });
});

describe("actions and post-state (VER-5)", () => {
  it("reports URL change, requests and settle time for a navigation click", async () => {
    await session.act({ type: "goto", url: "/dashboard" });
    const page = await session.observe();
    const outcome = await session.act({
      type: "click",
      target: { ref: find(page, "link", "Orders").ref },
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.post).toMatchObject({
      urlBefore: `${correct.url}/dashboard`,
      urlAfter: `${correct.url}/orders`,
      changed: true,
    });
    expect(
      outcome.post.requests.some((r) => r.resourceType === "document" && r.status === 200),
    ).toBe(true);
    expect(outcome.settledMs).toBeGreaterThanOrEqual(0);
  });

  it("settles the delayed projects list and reports how long it took", async () => {
    const outcome = await session.act({ type: "goto", url: "/dashboard" });
    expect(outcome.status).toBe("ok");
    expect(outcome.settle.timedOut).toBe(false);
    // The list loads after a fixed 600 ms, marked aria-busy until then.
    expect(outcome.settledMs).toBeGreaterThanOrEqual(500);
    expect(outcome.settle.waitedFor.busy).toBeGreaterThan(0);
    expect(outcome.post.requests.some((r) => r.url.endsWith("/api/projects"))).toBe(true);
    const page = await session.observe();
    expect(page.elements.some((e) => e.role === "listitem" && e.text === "Apollo")).toBe(true);
    const idle = await session.settle();
    expect(idle).toMatchObject({ timedOut: false, inflight: 0 });
  });

  it("reports an opened dialog and added elements", async () => {
    await session.act({ type: "goto", url: "/dashboard" });
    const page = await session.observe();
    const outcome = await session.act({
      type: "click",
      target: { ref: find(page, "button", "Create project").ref },
    });
    expect(outcome.post.changed).toBe(true);
    expect(outcome.post.dialogs).toContainEqual({ type: "dialog", message: "New project" });
    expect(outcome.post.added.some((e) => e.role === "textbox")).toBe(true);
    await session.act({ type: "press", key: "Escape" });
  });

  it("returns not_found for a missing target and refuses an unknown action", async () => {
    await session.act({ type: "goto", url: "/pricing" });
    expect(
      (await session.act({ type: "click", target: { kind: "role", role: "button", name: "Nope" } }))
        .status,
    ).toBe("not_found");
    const ambiguous = await session.act({
      type: "click",
      target: { kind: "role", role: "button", name: "Start free trial" },
    });
    expect(ambiguous.status).toBe("not_found");
    expect(ambiguous.message).toMatch(/matches 3 elements/);
    const unknown = await session.act({ type: "evaluate", script: "1" } as never);
    expect(unknown).toMatchObject({ status: "refused", reason: "invalid_action" });
  });

  it("select, check, hover, scroll, press, back, reload and waitFor all work", async () => {
    await session.act({ type: "goto", url: "/settings" });
    let page = await session.observe();
    const select = await session.act({
      type: "select",
      target: { ref: find(page, "combobox", "Time zone").ref },
      option: "Asia/Tokyo",
    });
    expect(select.status).toBe("ok");
    page = await session.observe();
    expect(
      page.elements.find((e) => e.role === "option" && e.name === "Asia/Tokyo")?.states.selected,
    ).toBe(true);
    expect(
      (
        await session.act({
          type: "hover",
          target: { ref: find(page, "button", "Save changes").ref },
        })
      ).status,
    ).toBe("ok");
    expect((await session.act({ type: "scroll", direction: "down" })).status).toBe("ok");
    expect(
      (
        await session.act({
          type: "scroll",
          target: { ref: find(page, "button", "Delete account").ref },
        })
      ).status,
    ).toBe("ok");
    expect((await session.act({ type: "press", key: "Tab" })).status).toBe("ok");
    expect((await session.act({ type: "waitFor", text: "Danger zone" })).status).toBe("ok");
    const waited = await session.act({
      type: "waitFor",
      text: "Never on this page",
      timeoutMs: 300,
    });
    expect(waited.status).toBe("timeout");
    await session.act({ type: "goto", url: "/orders" });
    const back = await session.act({ type: "back" });
    expect(back.post.urlAfter).toBe(`${correct.url}/settings`);
    expect((await session.act({ type: "reload" })).status).toBe("ok");
  });

  it("check, uncheck and dblclick (on a test page: the shop has no checkbox)", async () => {
    const pages = await hostile();
    try {
      const s = await open(pages.url, { browser });
      await s.act({ type: "goto", url: "/form" });
      let page = await s.observe();
      const box = { ref: find(page, "checkbox", "Remember me").ref };
      expect((await s.act({ type: "check", target: box })).post.changed).toBe(true);
      page = await s.observe();
      expect(find(page, "checkbox", "Remember me").states.checked).toBe(true);
      expect(
        (
          await s.act({
            type: "uncheck",
            target: { ref: find(page, "checkbox", "Remember me").ref },
          })
        ).status,
      ).toBe("ok");
      const twice = await s.act({
        type: "dblclick",
        target: { kind: "role", role: "button", name: "Twice" },
      });
      expect(twice.post.added).toContainEqual({ role: "paragraph", name: "", text: "double" });
      await s.close();
    } finally {
      await pages.stop();
    }
  });

  it("shows no change for the silent-click trap (broken-silent-click)", async () => {
    const trap = await shop("broken-silent-click");
    try {
      await seed(trap.url);
      const s = await open(trap.url, { browser });
      await login(s, PASSWORD);
      await s.act({ type: "goto", url: "/dashboard" });
      const page = await s.observe();
      const outcome = await s.act({
        type: "click",
        target: { ref: find(page, "button", "Create project").ref },
      });
      expect(outcome.status).toBe("ok");
      expect(outcome.post).toMatchObject({
        changed: false,
        added: [],
        removed: [],
        requests: [],
        dialogs: [],
      });
      expect(outcome.post.urlAfter).toBe(outcome.post.urlBefore);
      await s.close();
    } finally {
      await trap.stop();
    }
  });
});

describe("upload (SAF-2)", () => {
  it("is refused unless the test enables it", async () => {
    await session.act({ type: "goto", url: "/settings" });
    const page = await session.observe();
    const outcome = await session.act({
      type: "upload",
      target: { ref: find(page, "button", "Choose an image").ref },
      files: "avatar.png",
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "upload_not_allowed" });
  });

  it("uploads from the test's folder only", async () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "x.png"), "not really");
    const s = await open(correct.url, { browser, allowUpload: { dir: SHOP_FILES } });
    await login(s, PASSWORD);
    await s.act({ type: "goto", url: "/settings" });
    const page = await s.observe();
    const target = { ref: find(page, "button", "Choose an image").ref };
    expect(await s.act({ type: "upload", target, files: "../manifest.yaml" })).toMatchObject({
      status: "refused",
      reason: "file_outside_folder",
    });
    expect(await s.act({ type: "upload", target, files: join(outside, "x.png") })).toMatchObject({
      status: "refused",
      reason: "file_outside_folder",
    });
    expect(await s.act({ type: "upload", target, files: "missing.png" })).toMatchObject({
      status: "refused",
      reason: "file_outside_folder",
    });
    const ok = await s.act({ type: "upload", target, files: "avatar.png" });
    expect(ok.status).toBe("ok");
    const uploaded = await s.act({
      type: "click",
      target: { ref: find(page, "button", "Upload avatar").ref },
    });
    expect(uploaded.post.requests, JSON.stringify(uploaded)).toContainEqual(
      expect.objectContaining({
        method: "POST",
        url: expect.stringMatching(/\/api\/avatar$/),
        status: 200,
      }),
    );
    await s.close();
  });
});

describe("screenshots", () => {
  it("gives the model a JPEG at most 1280 px wide and evidence a full-resolution PNG", async () => {
    await session.act({ type: "goto", url: "/pricing" });
    const model = await session.screenshot({ forModel: true });
    expect(model).toMatchObject({ status: "ok", contentType: "image/jpeg" });
    expect([...model.bytes.slice(0, 2)]).toEqual([0xff, 0xd8]);
    expect(jpegWidth(model.bytes)).toBe(1280); // the default desktop preset is 1920 wide
    const evidence = await session.screenshot();
    expect(evidence.contentType).toBe("image/png");
    expect(pngWidth(evidence.bytes)).toBe(1920);
    const page = await session.observe();
    const crop = await session.screenshot({
      target: { ref: find(page, "heading", "Pricing").ref },
    });
    expect(crop.status).toBe("ok");
    expect(pngWidth(crop.bytes)).toBeLessThan(1920);
  });
});

function pngWidth(bytes: Uint8Array): number {
  return Buffer.from(bytes).readUInt32BE(16);
}

function jpegWidth(bytes: Uint8Array): number {
  const b = Buffer.from(bytes);
  for (let i = 2; i < b.length; ) {
    const marker = b.readUInt16BE(i);
    const length = b.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffc3) return b.readUInt16BE(i + 7);
    i += 2 + length;
  }
  return 0;
}
