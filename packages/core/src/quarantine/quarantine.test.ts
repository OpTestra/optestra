import { describe, expect, it } from "vitest";
import { muteState, parseUntil, withMute, withoutMute } from "./quarantine.js";

// Quarantine (DIA-5): mutes from the project file, with a reason and a last
// day; renewing is explicit; the day after, the test counts again.

const NOW = new Date("2026-10-01T12:00:00Z");
const test = { path: "tests/login.test.md", id: "tests__login" };

describe("muteState", () => {
  it("is muted through its last day, expired the day after, matched by file or id", () => {
    const entries = [
      { test: "tests/login.test.md", reason: "flaky upload (#12)", until: "2026-10-01" },
    ];
    expect(muteState(entries, test, NOW).muted).toMatchObject({
      reason: "flaky upload (#12)",
      until: "2026-10-01",
    });
    expect(muteState(entries, test, new Date("2026-10-02T00:00:01Z"))).toEqual({
      expired: expect.objectContaining({ until: "2026-10-01" }),
    });
    expect(
      muteState([{ ...entries[0], test: "tests__login" } as never], test, NOW).muted,
    ).toBeTruthy();
    expect(muteState(entries, { path: "tests/other.test.md", id: "tests__other" }, NOW)).toEqual(
      {},
    );
  });
});

describe("withMute", () => {
  it("adds a mute with a reason and a date or a span", () => {
    const change = withMute([], test, { reason: " flaky ", until: "14d" }, NOW);
    expect(change).toEqual({
      ok: true,
      entries: [{ test: "tests/login.test.md", reason: "flaky", until: "2026-10-15" }],
      entry: { test: "tests/login.test.md", reason: "flaky", until: "2026-10-15" },
      renewed: false,
    });
    expect(parseUntil("2w", NOW)).toBe("2026-10-15");
    expect(parseUntil("2026-02-30", NOW)).toBeUndefined();
  });

  it("needs a reason, a real future date within 90 days, and --renew to change one", () => {
    expect(withMute([], test, { reason: "", until: "7d" }, NOW)).toMatchObject({ ok: false });
    expect(withMute([], test, { reason: "x", until: "soon" }, NOW)).toMatchObject({ ok: false });
    expect(withMute([], test, { reason: "x", until: "2026-09-30" }, NOW)).toMatchObject({
      ok: false,
      message: "2026-09-30 is in the past.",
    });
    expect(withMute([], test, { reason: "x", until: "200d" }, NOW)).toMatchObject({
      ok: false,
      message: expect.stringContaining("at most 90 days"),
    });
    const entries = [{ test: "tests/login.test.md", reason: "old", until: "2026-09-20" }];
    expect(withMute(entries, test, { reason: "new", until: "7d" }, NOW)).toMatchObject({
      ok: false,
      message: expect.stringContaining("(expired)"),
    });
    const renewed = withMute(entries, test, { reason: "new", until: "7d", renew: true }, NOW);
    expect(renewed).toMatchObject({ ok: true, renewed: true });
    if (renewed.ok) expect(renewed.entries).toHaveLength(1);
  });

  it("unmutes", () => {
    const entries = [{ test: "tests/login.test.md", reason: "x", until: "2026-10-10" }];
    expect(withoutMute(entries, test)).toEqual({ entries: [], removed: entries[0] });
    expect(withoutMute([], test).removed).toBeUndefined();
  });
});

describe("muteSuggestion", () => {
  it("suggests muting a flaky test when flaky_or_real says intermittent, never otherwise", async () => {
    const { readRun } = await import("@optestra/contract/node");
    const { fileURLToPath } = await import("node:url");
    const { muteSuggestion } = await import("./quarantine.js");
    const dir = fileURLToPath(new URL("../../../contract/fixtures/v1/flaky", import.meta.url));
    const flaky = readRun(dir).tests[0];
    if (!flaky) throw new Error("no fixture");
    const asked: string[] = [];
    const decide = (intermittent: boolean) =>
      ({
        decide: async (task: string) => {
          asked.push(task);
          return { status: "decided", answers: { intermittent }, confidence: 0.82 };
        },
      }) as never;
    const yes = await muteSuggestion(flaky, decide(true), [{ verdict: "flaky", signature: null }]);
    expect(yes).toEqual({
      reason: "failed, then passed on a retry (and failed or was flaky in 1 of its last 1 runs)",
      confidence: 0.82,
    });
    expect(asked).toEqual(["flaky_or_real"]);
    expect(await muteSuggestion(flaky, decide(false), [])).toBeUndefined();
  });
});
