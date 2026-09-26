import type { CheckOp, Locator } from "@testament/recording";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocatorSpec, PageCopy, Session } from "@testament/browser";
import { ALLOWED, open, PASSWORD, secret, seed, shop } from "./helpers.js";

// The check evaluator (LOOP-2) on the real shop: every op type, auto-waiting,
// scopes and frames, templates, secrets refused, and the empty page and page
// copies the sanity test uses.

const BODY = { kind: "css", selector: "body" } as const;
const TABLE = { kind: "role", role: "table", name: "Your orders", exact: true } as const;
const ROWS = { kind: "css", selector: "tbody tr:visible" } as const;

let running: Awaited<ReturnType<typeof shop>>;
let session: Session;
let loginCopy: PageCopy;

async function logIn(target: Session): Promise<PageCopy> {
  await target.act({ type: "goto", url: "/login" });
  await target.act({
    type: "fill",
    target: { kind: "label", text: "Email" },
    value: "ada@example.com",
  });
  await target.act({
    type: "fill",
    target: { kind: "label", text: "Password" },
    value: { secret: "SHOP_PASSWORD" },
  });
  const copy = await target.pageCopy();
  await target.act({ type: "click", target: { kind: "role", role: "button", name: "Log in" } });
  return copy;
}

beforeAll(async () => {
  running = await shop("correct");
  await seed(running.url);
  session = await open(running.url, {
    secrets: { SHOP_PASSWORD: secret("SHOP_PASSWORD", PASSWORD, ALLOWED) },
  });
  loginCopy = await logIn(session);
});
afterAll(async () => {
  await session?.close();
  await running?.stop();
});

const check = (op: CheckOp, options: Parameters<Session["check"]>[1] = {}) =>
  session.check(op, { timeoutMs: 1_000, ...options });

describe("session.check (LOOP-2 evaluator)", () => {
  it("text: equals, contains and matches, with the text actually seen", async () => {
    await session.act({ type: "goto", url: "/orders" });
    const h1 = { kind: "role", role: "heading", level: 1 } as const;
    expect(
      await check({ type: "text", target: h1, match: "equals", value: "Orders" }),
    ).toMatchObject({
      status: "passed",
      expected: "Orders",
      actual: "Orders",
      matched: 1,
    });
    expect(
      await check(
        { type: "text", target: h1, match: "equals", value: "Order" },
        { timeoutMs: 300 },
      ),
    ).toMatchObject({ status: "failed", expected: "Order", actual: "Orders" });
    expect(
      await check({
        type: "text",
        target: { ...ROWS, nth: 0 },
        scope: TABLE,
        match: "matches",
        value: "A-1006[\\s\\S]*\\$12\\.00",
      }),
    ).toMatchObject({ status: "passed" });
    expect(
      await check({ type: "text", target: BODY, match: "contains", value: "Show refunded orders" }),
    ).toMatchObject({ status: "passed", actual: "Show refunded orders" });
    // Several matches: any one may match.
    expect(
      await check({
        type: "text",
        target: { kind: "role", role: "rowheader" },
        match: "equals",
        value: "A-1002",
      }),
    ).toMatchObject({ status: "passed", matched: 5 });
  });

  it("count: visible rows only, in a scope", async () => {
    await session.act({ type: "goto", url: "/orders" });
    expect(await check({ type: "count", target: ROWS, scope: TABLE, n: 5 })).toMatchObject({
      status: "passed",
      actual: "5",
    });
    expect(
      await check({ type: "count", target: ROWS, scope: TABLE, min: 6 }, { timeoutMs: 200 }),
    ).toMatchObject({ status: "failed", expected: "at least 6", actual: "5" });
    await session.act({ type: "click", target: { kind: "text", text: "Show refunded orders" } });
    expect(await check({ type: "count", target: ROWS, scope: TABLE, n: 6, max: 6 })).toMatchObject({
      status: "passed",
    });
  });

  it("url: is, contains and matches", async () => {
    await session.act({ type: "goto", url: "/orders?sort=total" });
    expect(await check({ type: "url", match: "is", value: "/orders" })).toMatchObject({
      status: "passed",
    });
    expect(await check({ type: "url", match: "contains", value: "sort=total" })).toMatchObject({
      status: "passed",
    });
    expect(
      await check({ type: "url", match: "matches", value: "/orders\\?sort=\\w+$" }),
    ).toMatchObject({
      status: "passed",
    });
    const miss = await check(
      { type: "url", match: "contains", value: "/billing" },
      { timeoutMs: 200 },
    );
    expect(miss).toMatchObject({ status: "failed", expected: "/billing" });
    expect(miss.actual).toContain("/orders?sort=total");
  });

  it("element_state: visible, hidden, editable, focused, empty, disabled", async () => {
    await session.act({ type: "goto", url: "/settings" });
    const button = (name: string) => ({ kind: "role", role: "button", name, exact: true }) as const;
    expect(
      await check({ type: "element_state", target: button("Delete account"), state: "visible" }),
    ).toMatchObject({
      status: "passed",
    });
    // A closed dialog is hidden; an element that isn't there is hidden too.
    expect(
      await check({
        type: "element_state",
        target: { kind: "role", role: "alertdialog", name: "Delete your account?" },
        state: "hidden",
      }),
    ).toMatchObject({ status: "passed" });
    expect(
      await check(
        { type: "element_state", target: button("Nope"), state: "visible" },
        { timeoutMs: 200 },
      ),
    ).toMatchObject({ status: "failed", actual: "(nothing matches the button 'Nope')" });
    const email = { kind: "label", text: "Email", exact: true } as const;
    const name = { kind: "label", text: "Full name", exact: true } as const;
    expect(await check({ type: "element_state", target: name, state: "editable" })).toMatchObject({
      status: "passed",
    });
    expect(
      await check({ type: "element_state", target: email, state: "editable" }, { timeoutMs: 200 }),
    ).toMatchObject({ status: "failed", actual: "not editable" });
    expect(
      await check(
        { type: "element_state", target: button("Save changes"), state: "disabled" },
        { timeoutMs: 200 },
      ),
    ).toMatchObject({ status: "failed" });
    await session.act({ type: "click", target: name });
    expect(await check({ type: "element_state", target: name, state: "focused" })).toMatchObject({
      status: "passed",
    });
    await session.act({ type: "fill", target: name, value: "" });
    expect(await check({ type: "element_state", target: name, state: "empty" })).toMatchObject({
      status: "passed",
    });
    expect(
      await check(
        { type: "element_state", target: button("Save changes"), state: "checked" },
        { timeoutMs: 200 },
      ),
    ).toMatchObject({ status: "failed", actual: "not checked" });
  });

  it("value: an input's value and a select's chosen option", async () => {
    await session.act({ type: "goto", url: "/settings" });
    await session.act({
      type: "select",
      target: { kind: "label", text: "Time zone" },
      option: "Europe/London",
    });
    expect(
      await check({
        type: "value",
        target: { kind: "label", text: "Time zone" },
        match: "equals",
        value: "Europe/London",
      }),
    ).toMatchObject({ status: "passed", actual: "Europe/London" });
    expect(
      await check(
        {
          type: "value",
          target: { kind: "label", text: "Full name" },
          match: "contains",
          value: "Ada King",
        },
        { timeoutMs: 200 },
      ),
    ).toMatchObject({ status: "failed", actual: "Ada Lovelace" });
  });

  it("value inside an iframe, through the frame path", async () => {
    await session.act({ type: "goto", url: "/checkout?plan=pro" });
    const card: Locator = {
      kind: "label",
      text: "Card number",
      frame: [{ kind: "title", text: "Secure card payment" }],
    };
    await session.act({ type: "fill", target: card as LocatorSpec, value: "4242 4242 4242 4242" });
    expect(
      await check({ type: "value", target: card, match: "equals", value: "4242 4242 4242 4242" }),
    ).toMatchObject({
      status: "passed",
    });
  });

  it("network: only requests since the current action step began, and while waiting", async () => {
    await session.act({ type: "goto", url: "/settings" });
    const save = { kind: "role", role: "button", name: "Save changes" } as const;
    const op: CheckOp = { type: "network", method: "POST", url: "/api/profile", status: 200 };
    // A save before this step began doesn't count.
    await session.act({ type: "click", target: save });
    const stepStart = await session.pageCopy();
    expect(await check(op, { since: stepStart, timeoutMs: 200 })).toMatchObject({
      status: "failed",
    });
    // The step's own save does, even when it happened before the check started.
    await session.act({ type: "click", target: save });
    expect(await check(op, { since: stepStart })).toMatchObject({ status: "passed" });
    expect(
      await check({ type: "network", method: "POST", url: "/api/*" }, { since: stepStart }),
    ).toMatchObject({ status: "passed" });
    // Without a step start, only what is seen while waiting counts.
    expect(await check(op, { timeoutMs: 200 })).toMatchObject({ status: "failed" });
  });

  it("text on a form field reads its value, like toHaveValue", async () => {
    await session.act({ type: "goto", url: "/settings" });
    const name = { kind: "label", text: "Full name", exact: true } as const;
    await session.act({ type: "fill", target: name, value: "Grace Hopper" });
    expect(
      await check({ type: "text", target: name, match: "equals", value: "Grace Hopper" }),
    ).toMatchObject({ status: "passed", actual: "Grace Hopper" });
    expect(
      await check(
        { type: "text", target: name, match: "equals", value: "Ada Lovelace" },
        { timeoutMs: 200 },
      ),
    ).toMatchObject({ status: "failed", actual: "Grace Hopper" });
    // A select: its option value.
    await session.act({
      type: "select",
      target: { kind: "label", text: "Time zone" },
      option: "Asia/Tokyo",
    });
    expect(
      await check({
        type: "text",
        target: { kind: "label", text: "Time zone" },
        match: "equals",
        value: "Asia/Tokyo",
      }),
    ).toMatchObject({ status: "passed" });
    // The same on a page copy (script-free sandbox) and inside an iframe.
    const copy = await session.pageCopy();
    expect(
      await check(
        { type: "text", target: name, match: "equals", value: "Grace Hopper" },
        { on: copy, timeoutMs: 0 },
      ),
    ).toMatchObject({ status: "passed" });
    await session.act({ type: "goto", url: "/checkout?plan=pro" });
    const card: Locator = {
      kind: "label",
      text: "CVC",
      frame: [{ kind: "title", text: "Secure card payment" }],
    };
    await session.act({ type: "fill", target: card as LocatorSpec, value: "123" });
    expect(
      await check({ type: "text", target: card, match: "equals", value: "123" }),
    ).toMatchObject({ status: "passed" });
  });

  it("auto-waits: the projects list loads after a delay", async () => {
    await session.act({ type: "goto", url: "/dashboard" });
    await session.act({ type: "reload" });
    const list = { kind: "role", role: "list", name: "Projects", exact: true } as const;
    const result = await session.check(
      { type: "text", target: list, match: "contains", value: "No projects yet." },
      { timeoutMs: 5_000 },
    );
    expect(result).toMatchObject({ status: "passed" });
    const miss = await session.check(
      { type: "text", target: list, match: "contains", value: "Q3 roadmap" },
      { timeoutMs: 600 },
    );
    expect(miss).toMatchObject({ status: "failed", actual: "No projects yet." });
    expect(miss.attempts).toBeGreaterThan(1);
    expect(miss.ms).toBeGreaterThanOrEqual(500);
    expect(
      await check({
        type: "aria_snapshot",
        target: list,
        snapshot: "- listitem: No projects yet.",
      }),
    ).toMatchObject({ status: "passed" });
  });

  it("binds templates, refuses secrets, and leaves code/soft/pending to others", async () => {
    await session.act({ type: "goto", url: "/settings" });
    expect(
      await check(
        {
          type: "value",
          target: { kind: "label", text: "Email" },
          match: "equals",
          value: "{{data.email}}",
        },
        { values: { "data.email": "ada@example.com" } },
      ),
    ).toMatchObject({ status: "passed", expected: "ada@example.com" });
    expect(
      await check({
        type: "text",
        target: BODY,
        match: "contains",
        value: "{{secret.SHOP_PASSWORD}}",
      }),
    ).toMatchObject({ status: "refused", passed: false });
    const literal = await check({ type: "text", target: BODY, match: "contains", value: PASSWORD });
    expect(literal).toMatchObject({ status: "refused" });
    expect(JSON.stringify(literal)).not.toContain(PASSWORD);
    for (const op of [
      { type: "code", code: "expect(1).toBe(1)" },
      { type: "pending" },
      { type: "soft_judgment", question: "q", screenshot: "page" },
    ] as CheckOp[]) {
      expect(await check(op)).toMatchObject({ status: "unsupported", passed: false });
    }
  });

  it("evaluates on an empty page and on a page copy (the sanity test's pages)", async () => {
    await session.act({ type: "goto", url: "/dashboard" });
    const h1: CheckOp = {
      type: "text",
      target: { kind: "role", role: "heading", level: 1 },
      match: "equals",
      value: "Dashboard",
    };
    const now = await check(h1);
    expect(now).toMatchObject({ status: "passed" });
    expect(await check(h1, { on: "blank", timeoutMs: 0 })).toMatchObject({
      status: "failed",
      matched: 0,
    });
    const before = await check(h1, { on: loginCopy, timeoutMs: 0 });
    expect(before).toMatchObject({ status: "failed", actual: "Log in" });
    expect(before.seen).not.toBe(now.seen);
    expect(
      await check({ type: "url", match: "contains", value: "/login" }, { on: loginCopy }),
    ).toMatchObject({
      status: "passed",
    });
    // Typed values are kept; the secret typed into the password field is not.
    expect(
      await check(
        {
          type: "value",
          target: { kind: "label", text: "Email" },
          match: "equals",
          value: "ada@example.com",
        },
        { on: loginCopy, timeoutMs: 0 },
      ),
    ).toMatchObject({ status: "passed" });
    expect(
      await check(
        { type: "value", target: { kind: "label", text: "Password" }, match: "equals", value: "" },
        { on: loginCopy, timeoutMs: 0 },
      ),
    ).toMatchObject({ status: "passed" });
    // The live page was not touched by any of this.
    expect(session.url).toContain("/dashboard");
  });
});

describe("session.check on broken builds", () => {
  it("broken-total: expected $0.00 due today, actual $29.00 due today", async () => {
    const broken = await shop("broken-total");
    try {
      await seed(broken.url, { trial: "pro" });
      const other = await open(broken.url, {
        secrets: { SHOP_PASSWORD: secret("SHOP_PASSWORD", PASSWORD, ALLOWED) },
      });
      await logIn(other);
      await other.act({ type: "goto", url: "/billing" });
      expect(
        await other.check(
          { type: "text", target: BODY, match: "contains", value: "$0.00 due today" },
          { timeoutMs: 300 },
        ),
      ).toMatchObject({
        status: "failed",
        expected: "$0.00 due today",
        actual: "$29.00 due today",
      });
      await other.close();
    } finally {
      await broken.stop();
    }
  });
});
