import { describe, expect, it } from "vitest";
import { stepVariables } from "../author/variables.js";
import type { ActionOutcome } from "../target/harness.js";
import { bindAction } from "./bind.js";
import { lateMatch, verifyOutcome } from "./post-state.js";
import { mergeRecording } from "./runner.js";
import { command, expanded, post, recordingFor, role, URL0 } from "./test-kit.test-support.js";

const outcome = (p: Partial<ReturnType<typeof post>>): ActionOutcome =>
  ({
    action: { type: "click", target: role("button", "x") },
    status: "ok",
    ms: 1,
    settledMs: 5,
    settle: {
      settledMs: 5,
      timedOut: false,
      waitedFor: { network: 0, dom: 0, busy: 0 },
      inflight: 0,
    },
    post: post(p),
  }) as ActionOutcome;

describe("binding a recorded command (REP-7)", () => {
  it("binds values by reference, keeps secrets as references, refuses unresolved ones", async () => {
    const test = await expanded(
      '1. Fill "Email" with {{data.email}}\n2. Fill "Password" with {{secret.SHOP_PASSWORD}}\n3. Go to {{env.MISSING}}\n4. Expect: the page shows "x"',
      "name: T\nstart: /login\ndata:\n  email: ada@example.com",
    );
    const [email, password, missing] = test.steps.map((s) => stepVariables(test, s));
    const field = role("textbox", "Email");
    expect(
      bindAction({ type: "fill", target: field, value: "{{data.email}}" }, email as never),
    ).toEqual({
      ok: true,
      action: { type: "fill", target: field, value: "ada@example.com" },
    });
    expect(
      bindAction(
        { type: "fill", target: field, value: "{{secret.SHOP_PASSWORD}}" },
        password as never,
      ),
    ).toEqual({
      ok: true,
      action: { type: "fill", target: field, value: { secret: "SHOP_PASSWORD" } },
    });
    expect(bindAction({ type: "goto", url: "{{env.MISSING}}" }, missing as never)).toMatchObject({
      ok: false,
      reason: "unresolved",
    });
    // A secret only ever goes to a field on its own, never into a URL.
    expect(
      bindAction({ type: "goto", url: "/x?p={{secret.SHOP_PASSWORD}}" }, password as never),
    ).toMatchObject({
      ok: false,
      reason: "secret",
    });
    expect(
      bindAction(
        { type: "select", target: field, option: ["\\{{literal", "{{data.email}}"] },
        email as never,
      ),
    ).toEqual({
      ok: true,
      action: { type: "select", target: field, option: ["{{literal", "ada@example.com"] },
    });
  });
});

describe("post-state at replay (VER-5)", () => {
  const vars = [{ ref: "params.email", value: "ada@example.com" }];

  it("verifies when some of the recorded effect shows up, in template form", () => {
    const result = verifyOutcome(
      { appeared: [{ role: "textbox", name: "Email", text: "{{params.email}}" }] },
      outcome({
        changed: true,
        added: [{ role: "textbox", name: "Email", text: "ada@example.com" }],
      }),
      vars,
    );
    expect(result.status).toBe("verified");
  });

  it("matches a reworded element by its text, and a request by method and route", () => {
    expect(
      verifyOutcome(
        { appeared: [{ role: "status", name: "", text: "Project created" }] },
        outcome({
          changed: true,
          added: [{ role: "status", name: "Saved", text: "Project created" }],
        }),
        vars,
      ).status,
    ).toBe("verified");
    expect(
      verifyOutcome(
        { requests: [{ method: "POST", route: "/api/projects", status: 201 }] },
        outcome({
          changed: true,
          requests: [
            {
              method: "POST",
              url: "http://h/api/projects?x=1",
              resourceType: "fetch",
              status: 503,
            },
          ],
        }),
        vars,
      ).status,
    ).toBe("verified");
  });

  it("is a mismatch when none of it shows up (the silent click)", () => {
    const result = verifyOutcome(
      { appeared: [{ role: "dialog", name: "New project" }] },
      outcome({}),
      vars,
    );
    expect(result).toMatchObject({ status: "mismatch", observed: "nothing changed on the page" });
    expect(result.expected).toContain('dialog "New project"');
  });

  it("counts a reorder (a table sort) only when the recording expects one", () => {
    expect(verifyOutcome({ reordered: true }, outcome({ reordered: true }), vars).status).toBe(
      "verified",
    );
    expect(verifyOutcome({ reordered: true }, outcome({}), vars).status).toBe("mismatch");
    expect(verifyOutcome({}, outcome({}), vars).status).toBe("not_checkable");
  });

  it("a recording that saw only the button itself flicker accepts any real change, never none", () => {
    const self = { role: "button", name: "Start trial" };
    const weak = { appeared: [self], removed: [self] };
    const alert = outcome({
      changed: true,
      added: [{ role: "alert", name: "", text: "Declined" }],
    });
    expect(verifyOutcome(weak, alert, vars, self).status).toBe("verified");
    expect(verifyOutcome(weak, outcome({}), vars, self).status).toBe("mismatch");
    // Without knowing which element was acted on, it stays strict.
    expect(verifyOutcome(weak, alert, vars).status).toBe("mismatch");
  });

  it("after a heal, the recorded element is looked for under its new name", () => {
    const expect_ = {
      removed: [{ role: "button", name: "Create" }],
      appeared: [{ role: "button", name: "Create" }],
      requests: [],
    };
    const renamed = outcome({
      changed: true,
      removed: [{ role: "button", name: "Save project" }],
    });
    expect(
      verifyOutcome({ ...expect_, urlChange: "/x" }, renamed, vars, {
        role: "button",
        name: "Create",
        renamedTo: "Save project",
      }).status,
    ).toBe("verified");
    expect(verifyOutcome({ ...expect_, urlChange: "/x" }, renamed, vars).status).toBe("mismatch");
  });

  it("a second look finds a late URL change or element", () => {
    const observation = {
      untrusted: true as const,
      url: URL0,
      title: "",
      observedAt: "",
      frames: [],
      refused: [],
      truncated: false,
      elements: [
        { role: "dialog", name: "New project", depth: 0, states: {}, interactive: false, frame: 0 },
      ],
    };
    expect(
      lateMatch({ appeared: [{ role: "dialog", name: "New project" }] }, URL0, observation, vars),
    ).toMatch(/a moment later/);
    expect(
      lateMatch({ urlChange: "/dashboard" }, "http://h/dashboard?x", observation, vars),
    ).toMatch(/dashboard/);
    expect(
      lateMatch({ appeared: [{ role: "alert", name: "Oops" }] }, URL0, observation, vars),
    ).toBeNull();
  });
});

describe("keeping what a run recorded (REP-4)", () => {
  it("replaces authored steps and checks only; everything else stays as recorded", async () => {
    const test = await expanded('1. Click "A"\n2. Click "B"\n3. Expect: the page shows "x"');
    const old = recordingFor(
      test,
      {
        'Click "A"': [command({ type: "click", target: role("button", "A") }, null)],
        'Click "B"': [command({ type: "click", target: role("button", "B") }, null)],
      },
      { 'the page shows "x"': { type: "pending" } },
    );
    const fresh = {
      ...old.steps[1],
      commands: [command({ type: "click", target: role("link", "B") }, null)],
    } as (typeof old.steps)[number];
    const check = {
      ...old.checks[0],
      check: { type: "url", match: "contains", value: "/x" },
    } as (typeof old.checks)[number];
    const merged = mergeRecording(
      test,
      old,
      { steps: [fresh], checks: [check], model: "p/m" },
      {
        testPath: "tests/t.test.md",
        target: "web",
        engineVersion: "0.1.0",
        browser: "chromium",
        device: "desktop",
        environment: "local",
        now: "2026-09-27T00:00:00.000Z",
      },
    );
    expect(merged.steps[0]).toBe(old.steps[0]);
    expect(merged.steps[1]?.commands[0]?.action).toEqual({
      type: "click",
      target: role("link", "B"),
    });
    expect(merged.checks[0]?.check.type).toBe("url");
    expect(merged.recordedWith.model).toBe("p/m");
  });
});
