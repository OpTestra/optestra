import { describe, expect, it } from "vitest";
import { ENGINE_CAPABILITIES, parseViewport } from "./index.js";

// The capabilities export (DESK-3): plain, versioned data the apps read.

describe("ENGINE_CAPABILITIES", () => {
  it("is plain data with a version, and survives JSON", () => {
    expect(ENGINE_CAPABILITIES.capabilitiesVersion).toBe(1);
    expect(JSON.parse(JSON.stringify(ENGINE_CAPABILITIES))).toEqual(ENGINE_CAPABILITIES);
  });

  it("lists what the apps check for", () => {
    const run = ENGINE_CAPABILITIES.runTests;
    for (const option of [
      "browsers",
      "devices",
      "signal",
      "evidence",
      "viewport",
      "node",
      "onEvent",
    ])
      expect(run.options).toContain(option);
    expect(run.evidenceModes).toEqual(["full", "failures", "minimal"]);
    expect(run.viewport).toEqual({ min: 200, max: 7680 });
    expect(run.signal && run.artifactEvents).toBe(true);
    expect(ENGINE_CAPABILITIES.targets).toEqual(["web", "android"]);
    expect(ENGINE_CAPABILITIES.draftTest).toBe(true);
    expect(ENGINE_CAPABILITIES.heals.policies).toEqual(["strict", "review", "auto"]);
    expect(ENGINE_CAPABILITIES.bench.evalGate).toBe(true);
  });
});

describe("parseViewport (TGT-3)", () => {
  it("reads WxH and checks objects", () => {
    expect(parseViewport("1280x720")).toEqual({ ok: true, viewport: { width: 1280, height: 720 } });
    expect(parseViewport(" 390 × 844 ")).toEqual({
      ok: true,
      viewport: { width: 390, height: 844 },
    });
    expect(parseViewport({ width: 1024, height: 768 })).toMatchObject({ ok: true });
  });

  it("refuses what isn't a sensible size, saying why", () => {
    expect(parseViewport("1280")).toMatchObject({
      ok: false,
      message: expect.stringContaining("like 1280x720"),
    });
    expect(parseViewport("100x720")).toMatchObject({
      ok: false,
      message: expect.stringContaining("width"),
    });
    expect(parseViewport("1280x9000")).toMatchObject({
      ok: false,
      message: expect.stringContaining("height"),
    });
    expect(parseViewport({ width: 800.5, height: 600 })).toMatchObject({ ok: false });
  });
});
