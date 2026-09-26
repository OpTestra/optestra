import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixture } from "./fixtures.test-support.js";
import { type Event, EventSchema, FoldError, foldEvents } from "./index.js";

const events = (): Event[] =>
  readFileSync(join(fixture("all-passed"), "events.ndjson"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => EventSchema.parse(JSON.parse(line)));

describe("foldEvents", () => {
  it("rejects incomplete and inconsistent streams", () => {
    const all = events();
    const cases: [Event[], RegExp][] = [
      [all.slice(0, -1), /no run.finished/],
      [all.slice(1), /first event must be run.started/],
      [[all[0] as Event, all[0] as Event], /does not follow/],
      [
        all.map((e, i) => (i === 3 ? { ...e, runId: "01M3EF2PM04CMHWHZ9D1V41QWZ" } : e)),
        /does not match/,
      ],
      [all.filter((e) => e.type !== "test.finished"), /open/],
      [all.filter((e) => e.type !== "attempt.started"), /unknown attempt/],
    ];
    for (const [stream, message] of cases) {
      expect(() => foldEvents(stream)).toThrow(FoldError);
      expect(() => foldEvents(stream)).toThrow(message);
    }
  });

  it("rejects a verdict that does not follow from its checks", () => {
    const stream = events().map((e) =>
      e.type === "check.evaluated" && e.check.id === "c1"
        ? { ...e, check: { ...e.check, passed: false } }
        : e,
    );
    expect(() => foldEvents(stream)).toThrow(/failing or blocked decider/);
  });
});
