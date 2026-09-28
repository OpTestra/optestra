import { describe, expect, it } from "vitest";
import { AndroidRequestMark, type CheckContext, evaluateCheck, ScreenCopy } from "./check.js";
import { Screen } from "./hierarchy.js";
import { screenOf } from "./hierarchy.test.js";
import type { RequestSummary } from "./types.js";

// Checks against the fixture's real screens, with no device: the context hands
// out screens and the request log.

function context(
  screens: Screen[],
  requests: RequestSummary[] = [],
  secret = "shop-demo-pass",
): CheckContext {
  let at = 0;
  return {
    screen: async () => screens[Math.min(at++, screens.length - 1)] ?? null,
    redact: (text) => text.replaceAll(secret, "[secret:SHOP_PASSWORD]"),
    mark: () => requests.length,
    requestsSince: (mark) => requests.slice(mark),
    blank: () =>
      new Screen(
        { windows: [], nodes: [], truncated: false, activity: null, rotation: 0 },
        { appPackage: "com.acme.shop" },
      ),
  };
}

const projects = screenOf("projects");

describe("checks on Android (LOOP-2 ops)", () => {
  it("text, url, count, element_state and value", async () => {
    const ctx = context([projects]);
    const heading = { kind: "role", role: "heading", level: 1 } as const;
    expect(
      (
        await evaluateCheck(
          { type: "text", target: heading, match: "equals", value: "Projects" },
          { timeoutMs: 0 },
          ctx,
        )
      ).status,
    ).toBe("passed");
    expect(
      (
        await evaluateCheck(
          { type: "url", match: "is", value: ".ProjectsActivity" },
          { timeoutMs: 0 },
          ctx,
        )
      ).passed,
    ).toBe(true);
    expect(
      (
        await evaluateCheck(
          { type: "url", match: "contains", value: "SignIn" },
          { timeoutMs: 0 },
          ctx,
        )
      ).passed,
    ).toBe(false);
    const count = await evaluateCheck(
      { type: "count", target: { kind: "role", role: "listitem" }, n: 2 },
      { timeoutMs: 0 },
      ctx,
    );
    expect(count).toMatchObject({ status: "passed", actual: "2", matched: 2 });
    const scoped = await evaluateCheck(
      {
        type: "text",
        target: { kind: "role", role: "listitem" },
        scope: { kind: "role", role: "list" },
        match: "contains",
        value: "Mobile",
      },
      { timeoutMs: 0 },
      ctx,
    );
    expect(scoped.passed).toBe(true);
    const settings = context([screenOf("settings")]);
    expect(
      (
        await evaluateCheck(
          { type: "element_state", target: { kind: "role", role: "switch" }, state: "checked" },
          { timeoutMs: 0 },
          settings,
        )
      ).passed,
    ).toBe(true);
    const filled = context([screenOf("sign-in-filled")]);
    expect(
      (
        await evaluateCheck(
          {
            type: "value",
            target: { kind: "label", text: "Email" },
            match: "equals",
            value: "ada@example.com",
          },
          { timeoutMs: 0 },
          filled,
        )
      ).passed,
    ).toBe(true);
  });

  it("says what it saw instead, and nothing matching is a plain failure", async () => {
    const ctx = context([projects]);
    const wrong = await evaluateCheck(
      {
        type: "text",
        target: { kind: "role", role: "heading" },
        match: "equals",
        value: "Dashboard",
      },
      { timeoutMs: 0 },
      ctx,
    );
    expect(wrong).toMatchObject({ status: "failed", expected: "Dashboard", actual: "Projects" });
    const missing = await evaluateCheck(
      {
        type: "element_state",
        target: { kind: "role", role: "button", name: "Delete" },
        state: "visible",
      },
      { timeoutMs: 0 },
      ctx,
    );
    expect(missing.status).toBe("failed");
    expect(missing.actual).toMatch(/nothing matches/);
    const hidden = await evaluateCheck(
      {
        type: "element_state",
        target: { kind: "role", role: "button", name: "Delete" },
        state: "hidden",
      },
      { timeoutMs: 0 },
      ctx,
    );
    expect(hidden.passed).toBe(true);
  });

  it("waits until the check passes (auto-waiting)", async () => {
    const ctx = context([screenOf("sign-in"), screenOf("sign-in"), projects]);
    const result = await evaluateCheck(
      {
        type: "text",
        target: { kind: "role", role: "heading" },
        match: "equals",
        value: "Projects",
      },
      { timeoutMs: 2_000 },
      ctx,
    );
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it("network checks count only requests since the step's mark", async () => {
    const requests: RequestSummary[] = [
      { method: "POST", url: "http://10.0.2.2:4180/login", resourceType: "http", status: 303 },
    ];
    const ctx = context([projects], requests);
    const mark = AndroidRequestMark.create(1);
    requests.push({
      method: "POST",
      url: "http://10.0.2.2:4180/api/projects",
      resourceType: "http",
      status: 201,
    });
    const op = { type: "network", method: "POST", url: "/api/:collection", status: 201 } as const;
    expect((await evaluateCheck(op, { timeoutMs: 0, since: mark }, ctx)).passed).toBe(true);
    const login = { type: "network", method: "POST", url: "/login" } as const;
    expect((await evaluateCheck(login, { timeoutMs: 0, since: mark }, ctx)).passed).toBe(false);
  });

  it("refuses secrets as check values, and reports what it can't run", async () => {
    const ctx = context([projects]);
    const byRef = await evaluateCheck(
      {
        type: "text",
        target: { kind: "role", role: "heading" },
        match: "equals",
        value: "{{secret.SHOP_PASSWORD}}",
      },
      { timeoutMs: 0 },
      ctx,
    );
    expect(byRef.status).toBe("refused");
    const literal = await evaluateCheck(
      {
        type: "text",
        target: { kind: "role", role: "heading" },
        match: "contains",
        value: "shop-demo-pass",
      },
      { timeoutMs: 0 },
      ctx,
    );
    expect(literal.status).toBe("refused");
    for (const op of [
      { type: "code", code: "x" },
      { type: "pending" },
      { type: "soft_judgment", question: "Looks right?", screenshot: "page" },
      { type: "aria_snapshot", target: { kind: "role", role: "list" }, snapshot: "- list" },
    ] as const) {
      expect((await evaluateCheck(op, {}, ctx)).status, op.type).toBe("unsupported");
    }
  });

  it("runs on a frozen copy or an empty screen, never waiting", async () => {
    const copy = ScreenCopy.create(projects, 0, projects.url);
    const ctx = context([screenOf("sign-in")]);
    const onCopy = await evaluateCheck(
      {
        type: "text",
        target: { kind: "role", role: "heading" },
        match: "equals",
        value: "Projects",
      },
      { on: copy, timeoutMs: 5_000 },
      ctx,
    );
    expect(onCopy).toMatchObject({ passed: true, attempts: 1 });
    const blank = await evaluateCheck(
      { type: "count", target: { kind: "role", role: "listitem" }, n: 0 },
      { on: "blank" },
      ctx,
    );
    expect(blank.passed).toBe(true);
  });

  it("the seen hash tells whether the subject changed (VER-6)", async () => {
    const op = {
      type: "text",
      target: { kind: "role", role: "textbox", name: "Email" },
      match: "equals",
      value: "x",
    } as const;
    const a = await evaluateCheck(
      op,
      { on: ScreenCopy.create(screenOf("sign-in"), 0, "") },
      context([]),
    );
    const b = await evaluateCheck(
      op,
      { on: ScreenCopy.create(screenOf("sign-in-filled"), 0, "") },
      context([]),
    );
    const c = await evaluateCheck(
      op,
      { on: ScreenCopy.create(screenOf("sign-in"), 0, "") },
      context([]),
    );
    expect(a.seen).not.toBe(b.seen);
    expect(a.seen).toBe(c.seen);
  });
});

describe("toasts (MOB-1)", () => {
  it("counts a toast for a message region and for the whole screen, not for other targets", async () => {
    const asked: number[] = [];
    const ctx: CheckContext = {
      ...context([projects]),
      toasts: async (since) => {
        asked.push(since);
        return ["Project created"];
      },
    };
    const text = (target: object) =>
      evaluateCheck(
        { type: "text", target: target as never, match: "contains", value: "Project created" },
        { timeoutMs: 0 },
        ctx,
      );
    expect((await text({ kind: "role", role: "status" })).passed).toBe(true);
    expect((await text({ kind: "css", selector: "body" })).passed).toBe(true);
    expect((await text({ kind: "role", role: "heading" })).passed).toBe(false);
    // Without a mark, the last few seconds count.
    expect(asked.every((t) => Date.now() - t >= 6_000 && Date.now() - t < 60_000)).toBe(true);
  });
});
