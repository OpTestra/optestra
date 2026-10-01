import { readdirSync, readFileSync } from "node:fs";
import { brand } from "@optestra/brand";
import { describe, expect, it } from "vitest";
import { describeCheck, parseRecording, serializeRecording } from "./index.js";

// The shop's committed recordings (authored with a real model, LOOP-1.1) must
// stay readable as the format is extended: LOOP-2 only adds optional fields,
// ops and enum values.

const dir = new URL(`../../../bench/fixtures/shop/tests/.${brand.cliName}/`, import.meta.url);
const files = readdirSync(dir).filter((file) => file.endsWith(".steps.json"));

describe("committed shop recordings", () => {
  it("exist", () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  it.each(files)("%s parses, round-trips and describes its checks", (file) => {
    const text = readFileSync(new URL(file, dir), "utf8");
    const parsed = parseRecording(text);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(serializeRecording(parsed.recording)).toBe(text);
    for (const check of parsed.recording.checks) expect(describeCheck(check.check)).toBeTruthy();
  });
});
