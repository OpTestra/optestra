import type { ExpandedStep } from "@optestra/spec";
import { describe, expect, it } from "vitest";
import { stepLabelOf } from "./replay.js";
import {
  command,
  expanded,
  facts,
  fakeSession,
  fingerprint,
  post,
  recordingFor,
  replay,
  role,
} from "./test-kit.test-support.js";

// PERF-0: replay waits for each command's recorded effect instead of a fixed
// quiet window, without weakening what a pass means; screenshots, abort and
// step numbering.

const OPEN = 'Click "New project"';
const TITLE = 'Expect: a dialog titled "New project" is open';
const DIALOG = { role: "dialog", name: "New project" };
const button = facts("button", "New project");
const primary = role("button", "New project");
const loc = (l: unknown) => JSON.stringify(l);
const DIALOG_CHECK = {
  type: "element_state",
  target: { kind: "role", role: "dialog", name: "New project" },
  state: "visible",
} as const;

async function openDialog(expectPost: Parameters<typeof command>[2] = { appeared: [DIALOG] }) {
  const test = await expanded(`1. ${OPEN}\n2. ${TITLE}`);
  const recording = recordingFor(
    test,
    {
      [OPEN]: [
        command({ type: "click", target: primary }, fingerprint(primary, button), expectPost),
      ],
    },
    { [TITLE.slice("Expect: ".length)]: DIALOG_CHECK },
  );
  return { test, recording };
}

describe("learned waits (LRN-4, PERF-0)", () => {
  it("waits for the command's recorded effect, with the learned time as the ceiling", async () => {
    const { test, recording } = await openDialog();
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      effect: () => ({ post: { changed: true, added: [DIALOG] } }),
    });
    const { result } = await replay(test, recording, session);
    expect(result.status).toBe("passed");
    const wait = session.waits.actOptions.at(-1);
    expect(wait?.until).toBeTypeOf("function");
    expect(wait?.ceilingMs).toBeGreaterThanOrEqual(1_000);
    expect(wait?.ceilingMs).toBeLessThanOrEqual(3_000);
    // The effect ends the wait; nothing else does.
    expect(wait?.until?.(post({ added: [DIALOG], changed: true }))).toBe(true);
    expect(wait?.until?.(post({ added: [{ role: "status", name: "", text: "x" }] }))).toBe(false);
    expect(wait?.until?.(post())).toBe(false);
  });

  it("still fails when the effect never shows (the silent-click trap), after the wait", async () => {
    const { test, recording } = await openDialog();
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      effect: () => ({ post: { changed: false } }),
    });
    const { result } = await replay(test, recording, session);
    expect(result.status).toBe("failed");
    expect(result.steps[0]).toMatchObject({ status: "failed", postState: { status: "mismatch" } });
    expect(result.steps[0]?.error).toMatch(/right element was used, but nothing happened/);
    // The late second look ran too: it didn't make a pass out of nothing.
    expect(result.steps[1]?.status).toBe("skipped");
  });

  it("waits for every recorded write to be sent, not just for the page to change", async () => {
    const { test, recording } = await openDialog({
      appeared: [DIALOG],
      requests: [
        { method: "POST", route: "/api/projects", status: 201 },
        // A read (the page loading its data) is not waited for.
        { method: "GET", route: "/api/projects", status: 200 },
      ],
    });
    const session = fakeSession({ locators: { [loc(primary)]: button } });
    await replay(test, recording, session);
    const until = session.waits.actOptions.at(-1)?.until;
    expect(until?.(post({ added: [DIALOG], changed: true }))).toBe(false);
    expect(
      until?.(
        post({
          added: [DIALOG],
          changed: true,
          requests: [
            {
              method: "POST",
              url: "http://127.0.0.1:4100/api/projects",
              resourceType: "fetch",
              status: 201,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("settles with the quiet window when the command recorded no effect", async () => {
    const { test, recording } = await openDialog({});
    const session = fakeSession({ locators: { [loc(primary)]: button } });
    await replay(test, recording, session);
    expect(session.waits.actOptions.at(-1)).toBeUndefined();
  });

  it("a check that fails on the page before the action auto-waits; any other waits for a settled page", async () => {
    const test = await expanded(
      `1. ${OPEN}\n2. ${TITLE}\n3. Expect: the page heading is "Projects"`,
    );
    const recording = recordingFor(
      test,
      {
        [OPEN]: [
          command({ type: "click", target: primary }, fingerprint(primary, button), {
            appeared: [DIALOG],
          }),
        ],
      },
      {
        'a dialog titled "New project" is open': DIALOG_CHECK,
        'the page heading is "Projects"': {
          type: "text",
          target: { kind: "role", role: "heading" },
          match: "equals",
          value: "Projects",
        },
      },
    );
    // The heading didn't change with the click: its sanity test couldn't use the page before.
    const heading = recording.checks[1];
    if (heading?.sanity)
      heading.sanity.before = {
        result: "skipped",
        note: "The preceding action didn't change what this check looks at.",
      };
    const order: string[] = [];
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      effect: () => ({ post: { changed: true, added: [DIALOG] } }),
      onSettle: () => order.push("settle"),
      check: (op) => {
        order.push((op as { type: string }).type);
        return {
          status: "passed",
          passed: true,
          expected: "x",
          actual: "x",
          ms: 1,
          attempts: 1,
          seen: "s",
        };
      },
    });
    const { result } = await replay(test, recording, session);
    expect(result.status).toBe("passed");
    // The dialog check runs at once; the heading check only after the page settled.
    expect(order).toEqual(["element_state", "settle", "text"]);
  });

  it("an element not there yet after an early move-on: settle, look again, then act", async () => {
    const test = await expanded(`1. ${OPEN}\n2. Click "Create"`);
    const create = role("button", "Create");
    const createFacts = facts("button", "Create");
    const recording = recordingFor(test, {
      [OPEN]: [
        command({ type: "click", target: primary }, fingerprint(primary, button), {
          appeared: [DIALOG],
        }),
      ],
      'Click "Create"': [
        command({ type: "click", target: create }, fingerprint(create, createFacts), {
          removed: [DIALOG],
        }),
      ],
    });
    const locators: Record<string, ReturnType<typeof facts>> = { [loc(primary)]: button };
    const session = fakeSession({
      locators,
      effect: (action) =>
        JSON.stringify(action).includes('"Create"')
          ? { post: { changed: true, removed: [DIALOG] } }
          : { post: { changed: true, added: [DIALOG] } },
      // The dialog's button renders a moment after the dialog itself.
      onSettle: () => {
        locators[loc(create)] = createFacts;
      },
    });
    const { result } = await replay(test, recording, session, { mode: "replay-only" });
    expect(result.status).toBe("passed");
    expect(result.steps.map((s) => [s.status, s.recovery])).toEqual([
      ["passed", "replay"],
      ["passed", "replay"],
    ]);
    expect(session.waits.settles).toBe(1);
  });

  it("an element that never shows is still a miss (replay-only: no heal)", async () => {
    const test = await expanded(`1. ${OPEN}\n2. Click "Create"`);
    const create = role("button", "Create");
    const recording = recordingFor(test, {
      [OPEN]: [
        command({ type: "click", target: primary }, fingerprint(primary, button), {
          appeared: [DIALOG],
        }),
      ],
      'Click "Create"': [
        command({ type: "click", target: create }, fingerprint(create, facts("button", "Create"))),
      ],
    });
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      effect: () => ({ post: { changed: true, added: [DIALOG] } }),
    });
    const { result } = await replay(test, recording, session, { mode: "replay-only" });
    expect(result.status).toBe("failed");
    expect(result.steps[1]?.error).toMatch(/Element not found/);
    expect(session.waits.settles).toBe(1);
  });
});

describe("step screenshots (EVD-1, PERF-0)", () => {
  it("one screenshot per action step: JPEG in the background where it passed, PNG where it failed", async () => {
    const test = await expanded(`1. ${OPEN}\n2. Click "Create"`);
    const create = role("button", "Create");
    const recording = recordingFor(test, {
      [OPEN]: [
        command({ type: "click", target: primary }, fingerprint(primary, button), {
          appeared: [DIALOG],
        }),
      ],
      'Click "Create"': [
        command({ type: "click", target: create }, fingerprint(create, facts("button", "Create"))),
      ],
    });
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      effect: () => ({ post: { changed: true, added: [DIALOG] } }),
    });
    const saved: string[] = [];
    const { result } = await replay(test, recording, session, {
      mode: "replay-only",
      screenshotPath: (index, when, type) =>
        `steps/${index}-${when}.${type === "image/png" ? "png" : "jpg"}`,
      saveScreenshot: (index, when, _bytes, type) => {
        const path = `steps/${index}-${when}.${type === "image/png" ? "png" : "jpg"}`;
        saved.push(path);
        return path;
      },
    });
    expect(result.status).toBe("failed");
    expect(result.steps[0]?.screenshots).toEqual({
      before: "steps/0-before.jpg",
      after: "steps/0-after.jpg",
    });
    // The next step starts where the last one ended: its "before" is that screenshot.
    expect(result.steps[1]?.screenshots).toEqual({
      before: "steps/0-after.jpg",
      after: "steps/1-after.png",
    });
    // Every background screenshot landed before the attempt ended.
    expect(saved.sort()).toEqual(["steps/0-after.jpg", "steps/0-before.jpg", "steps/1-after.png"]);
  });

  it('"failures": only the step that failed gets a screenshot', async () => {
    const { test, recording } = await openDialog();
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      effect: () => ({ post: { changed: false } }),
    });
    const saved: string[] = [];
    const { result } = await replay(test, recording, session, {
      screenshots: "failures",
      saveScreenshot: (index, when, _bytes, type) => {
        saved.push(`${index}-${when}:${type}`);
        return `${index}-${when}`;
      },
    });
    expect(result.status).toBe("failed");
    expect(saved).toEqual(["0-after:image/png"]);
    expect(result.steps[0]?.screenshots).toEqual({ before: null, after: "0-after" });
  });
});

describe("abort (runTests({ signal }))", () => {
  it("stops before the next step: the rest is skipped and the attempt is blocked aborted", async () => {
    const { test, recording } = await openDialog();
    const stop = new AbortController();
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      effect: () => ({ post: { changed: true, added: [DIALOG] } }),
    });
    const { result } = await replay(test, recording, session, {
      signal: stop.signal,
      emit: (event) => {
        if (event.type === "step.finished") stop.abort();
      },
    });
    expect(result.status).toBe("blocked");
    expect(result.blocked).toMatchObject({ reason: "aborted", stepIndex: 1 });
    expect(result.steps.map((s) => s.status)).toEqual(["passed", "skipped"]);
    expect(result.checks).toHaveLength(0);
  });
});

describe("step numbering (DIA-3)", () => {
  const step = (fields: Partial<ExpandedStep>): ExpandedStep =>
    ({
      index: 5,
      kind: "action",
      number: 4,
      text: 'Click "Log in"',
      bound: [],
      display: "",
      textKey: "k",
      flowPath: [],
      origin: [{ file: "tests/a.test.md", line: 9, number: 7 }],
      ...fields,
    }) as ExpandedStep;

  it("is the test file's own number", () => {
    expect(stepLabelOf(step({}))).toBe("7");
  });

  it('inside a flow: "1 › Log in step 4", for each flow on the way', () => {
    expect(
      stepLabelOf(
        step({
          flowPath: ["tests/flows/login.test.md"],
          origin: [
            { file: "tests/a.test.md", line: 6, number: 1, flow: "Log in" },
            { file: "tests/flows/login.test.md", line: 9, number: 4 },
          ],
        }),
      ),
    ).toBe("1 › Log in step 4");
    expect(
      stepLabelOf(
        step({
          flowPath: ["tests/flows/a.test.md", "tests/flows/b.test.md"],
          origin: [
            { file: "tests/a.test.md", line: 6, number: 2, flow: "Sign up" },
            { file: "tests/flows/a.test.md", line: 7, number: 3, flow: "Verify" },
            { file: "tests/flows/b.test.md", line: 9, number: 1 },
          ],
        }),
      ),
    ).toBe("2 › Sign up step 3 › Verify step 1");
  });

  it("headlines and step results use the same number", async () => {
    const { test, recording } = await openDialog();
    const session = fakeSession({
      locators: { [loc(primary)]: button },
      effect: () => ({ post: { changed: false } }),
    });
    const { result } = await replay(test, recording, session);
    expect(result.steps.map((s) => s.label)).toEqual(["1", "2"]);
    expect(result.failure?.headline).toMatch(/^Step 1 "Click "New project""/);
  });
});
