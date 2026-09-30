import { describe, expect, it } from "vitest";
import { runModelEval } from "../src/bench/models.js";

// The model eval pipeline end to end with the scripted stand-in (CI, no AI):
// authoring, the model's recordings replayed on every variant, cosmetic with
// the fixer. A stand-in that gives up records nothing, so nothing can pass on
// its recordings: no false passes, every must-pass test a false fail.

describe("bench --scripted (real browser, no AI)", () => {
  it("runs every part and reports honest zeros", async () => {
    const file = await runModelEval({
      entries: [{ provider: "scripted", model: "stand-in" }],
      scripted: true,
    });
    expect(file).toMatchObject({ kind: "model-eval", fixture: "shop", scripted: true });
    const [m] = file.models;
    expect(m?.model).toBe("scripted:stand-in");
    expect(m?.authoring).toMatchObject({ tests: 11, passed: 0, stepsAuthored: 0, costUsd: 0 });
    expect(m?.authoring.aiCalls).toBeGreaterThan(0);
    expect(m?.falsePasses).toBe(0);
    expect(m?.replay.falseFail.count).toBe(m?.replay.falseFail.of);
    expect(m?.fixer.healedByFixer).toBe(0);
  }, 600_000);
});
