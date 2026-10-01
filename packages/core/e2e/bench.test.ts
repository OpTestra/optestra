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

// COST-0: the corpus scorer is honest. The tidy control (the gold tests) through
// the scripted path replays the committed recordings and must give exactly the
// gold verdicts: no false pass, no false fail, nothing else off; the cosmetic
// misses only an AI heal could fix count as "needs AI", as in Bench.
describe("bench --corpus --scripted (real browser, no AI)", () => {
  it("reproduces the gold verdicts with the tidy control", async () => {
    const { runCorpus } = await import("../src/bench/corpus.js");
    const file = await runCorpus({
      entry: { provider: "scripted", model: "stand-in" },
      scripted: true,
      styles: ["tidy"],
    });
    const [tidy] = file.styles;
    expect(tidy).toMatchObject({ fixture: "shop", style: "tidy", route: "file", entries: 11 });
    expect(tidy?.lint).toMatchObject({ clean: 11, rejected: 0 });
    expect(tidy?.authoring).toMatchObject({ tests: 11, passed: 11, calls: 0 });
    expect(tidy?.falsePass.count).toBe(0);
    expect(tidy?.falseFail.count).toBe(0);
    expect(tidy?.otherMismatches).toEqual([]);
    // Bench's baseline: 8 of 11 cosmetic tests pass with no AI; the rest need an AI heal.
    expect(tidy?.cosmetic.passedOrHealed ?? 0).toBeGreaterThanOrEqual(8);
    expect(tidy?.cosmetic.calls).toBe(0);
  }, 900_000);
});
