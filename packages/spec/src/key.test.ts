import { describe, expect, it } from "vitest";
import { expandTest, mapReader } from "./expand.js";
import { normalizeText } from "./key.js";
import { parseTest } from "./parse.js";
import { file } from "./spec.test-support.js";

const FLOW = file(
  ["name: F", "kind: flow", "params:", "  email: a@b.test"],
  ["1. Go to /login", "2. Fill {{params.email}}"],
);

async function keys(body: string[], data: string[] = []) {
  const text = file(["name: T", ...(data.length > 0 ? ["data:", ...data] : [])], body);
  const { spec } = parseTest(text, "tests/t.test.md");
  const expanded = await expandTest(spec, {
    readFile: mapReader({ "tests/flows/f.test.md": FLOW }),
    seed: String(Math.random()),
  });
  return Object.fromEntries(
    expanded.steps.map((s) => [s.display.replace(/\d{3,}.*/, ""), s.textKey]),
  );
}

describe("textKey (REP-4, REP-7)", () => {
  const base = [
    '1. Click "Start"',
    "2. Use: flows/f.test.md",
    '3. Expect: the heading is "Hi"',
    "4. Reload",
  ];

  it("does not change other steps when one is inserted, removed or reworded", async () => {
    const before = await keys(base);
    const inserted = await keys(['1. Click "Start"', "2. Wait for the banner", ...base.slice(1)]);
    const removed = await keys([base[0] ?? "", base[1] ?? "", base[3] ?? ""]);
    const reworded = await keys([
      base[0] ?? "",
      base[1] ?? "",
      '3. Expect: the heading says "Hi"',
      base[3] ?? "",
    ]);
    for (const [text, key] of Object.entries(before)) {
      expect(inserted[text], text).toBe(key);
      if (text !== 'the heading is "Hi"') {
        expect(removed[text], text).toBe(key);
        expect(reworded[text], text).toBe(key);
      }
    }
    expect(reworded['the heading says "Hi"']).not.toBe(before['the heading is "Hi"']);
  });

  it("does not depend on step numbers, spacing or quote style", async () => {
    const a = await keys(['1. Click  "Save"', '2. Expect: it says "Done"']);
    const b = await keys(["5.   Click “Save” ", "   ", "9. Expect: it says 'Done'"]);
    expect(Object.values(b)).toEqual(Object.values(a));
  });

  it("uses variable names, not values", async () => {
    const one = await keys(["1. Sign up with {{data.email}}"], ["  email: one@example.com"]);
    const two = await keys(["1. Sign up with {{data.email}}"], ["  email: two@example.com"]);
    const renamed = await keys(["1. Sign up with {{data.mail}}"], ["  mail: one@example.com"]);
    expect(Object.values(one)).toEqual(Object.values(two));
    expect(Object.values(one)).not.toEqual(Object.values(renamed));
    const spaced = await keys(["1. Sign up with {{ data.email }}"], ["  email: x@example.com"]);
    expect(Object.values(spaced)).toEqual(Object.values(one));
  });

  it("separates kinds, flow chains and repeated steps", async () => {
    const body = [
      "1. Go to /login",
      "2. Expect: Go to /login",
      "3. Use: flows/f.test.md",
      "4. Go to /login",
    ];
    const { spec } = parseTest(file("name: T", body), "tests/t.test.md");
    const expanded = await expandTest(spec, {
      readFile: mapReader({ "tests/flows/f.test.md": FLOW }),
      seed: "x",
    });
    // "Go to /login" appears as an action, an expect, inside the flow and again: four keys.
    const keys = expanded.steps.map((s) => s.textKey);
    expect(expanded.steps.map((s) => s.display)).toEqual([
      "Go to /login",
      "Go to /login",
      "Go to /login",
      "Fill a@b.test",
      "Go to /login",
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is a stable 16-character hex string", async () => {
    const { spec } = parseTest(file("name: T", '1. Click "Start"'), "tests/t.test.md");
    const expanded = await expandTest(spec, { readFile: mapReader({}), seed: "x" });
    // Pinned: changing the recipe must bump TEXT_KEY_VERSION (recordings are stored under these keys).
    expect(expanded.steps[0]?.textKey).toBe("a1e32e23e7b6b38f");
  });

  it("normalizes whitespace and quotes", () => {
    expect(normalizeText("  a \t “b”  ‘c’ `d` \n e ")).toBe('a "b" "c" "d" e');
  });
});
