import type { AndroidSession } from "@testament/android";
import type { Session } from "@testament/browser";
import { describe, expect, it } from "vitest";
import type { HarnessSession } from "./harness.js";

// One engine, two targets (MOB-1 guarantee 1): both harnesses' sessions fit the
// engine's HarnessSession as they are. This is checked by the compiler.
const fits = (web: Session, android: AndroidSession): HarnessSession[] => [web, android];

describe("the target layer", () => {
  it("takes a web and an Android session alike (compile-time)", () => {
    expect(typeof fits).toBe("function");
  });
});
