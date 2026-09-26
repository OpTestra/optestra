import { describe, expect, it } from "vitest";
import { checkTest } from "../check.js";
import { mapReader } from "../expand.js";
import { createRng } from "../generators.js";
import { specSteps } from "../model.js";
import { parseTest } from "../parse.js";
import { applySafeFixes } from "./lint.js";
import { applyEdits, isCheckStep } from "./source.js";

// Guarantee 2 (HEAL-3): --fix never changes an Expect:, Soft: or Never: line.

const ACTIONS = [
  'Fill "Email" with ada@example.com',
  "Sign up with bob@example.com",
  "Wait 3 seconds",
  "Log in normally",
  'Fill "Password" with hunter2hunter2',
  'Click "Delete project"',
  'Click "Continue"',
  "Pause for 2 s",
  "Click it",
];
const CHECKS = [
  'Expect: the page shows "ada@example.com"',
  "Expect: it works",
  'Expect: the page shows "A" and "B"',
  "Soft: the chart looks right",
  "Expect: the token sk_live_abcdefghijklmnop is shown",
  "Expect: the URL contains /done",
];
const GUARDS = [
  'Never: click "Delete account"',
  "Never: break anything",
  "Never: email bob@example.com",
];

function generate(seed: number): string {
  const rng = createRng(`fix-${seed}`);
  const body: string[] = [];
  let n = 1;
  for (let i = 0; i < 3 + rng.int(8); i++) {
    const roll = rng.int(10);
    if (roll < 5) body.push(`${n++}. ${rng.pick(ACTIONS)}`);
    else if (roll < 8) body.push(`${n++}. ${rng.pick(CHECKS)}`);
    else body.push(rng.pick(GUARDS));
  }
  const front = ["name: New user signs up", "start: /signup"];
  if (rng.int(2) === 0) front.push("data:", "  other: x");
  return `---\n${front.join("\n")}\n---\n\n${body.join("\n")}\n`;
}

const check = async (text: string) =>
  (await checkTest(text, "tests/t.test.md", { readFile: mapReader({}) })).findings;

const checkLines = (text: string) =>
  specSteps(parseTest(text, "tests/t.test.md").spec)
    .filter(isCheckStep)
    .map((s) =>
      text
        .split("\n")
        .slice((s.at?.range.start.line ?? 1) - 1, s.at?.range.end.line)
        .join("\n"),
    );

describe("safe fixes", () => {
  it("never change an Expect:, Soft: or Never: line, and are idempotent", async () => {
    let changed = 0;
    for (let seed = 0; seed < 150; seed++) {
      const text = generate(seed);
      const first = await applySafeFixes(text, check);
      if (first.text !== text) changed++;
      expect(checkLines(first.text), text).toEqual(checkLines(text));
      const second = await applySafeFixes(first.text, check);
      expect(second.text, text).toBe(first.text);
      expect(second.applied).toEqual([]);
    }
    expect(changed).toBeGreaterThan(20);
  });

  it("marks every fix on an expectation line unsafe", async () => {
    for (let seed = 0; seed < 150; seed++) {
      const text = generate(seed);
      const findings = await check(text);
      const lines = new Set(
        specSteps(parseTest(text, "tests/t.test.md").spec)
          .filter(isCheckStep)
          .flatMap((s) => [s.at?.range.start.line]),
      );
      for (const f of findings) {
        for (const fix of f.fixes.filter((x) => x.safe)) {
          for (const edit of fix.edits) {
            const insertion =
              edit.range.start.column === 1 &&
              edit.range.start.line === edit.range.end.line &&
              edit.range.end.column === 1;
            if (!insertion)
              expect(lines.has(edit.range.start.line), `${f.rule} ${text}`).toBe(false);
          }
        }
      }
    }
  });

  it("applyEdits keeps CRLF and a BOM", () => {
    const text = "﻿a\r\nb\r\n";
    const out = applyEdits(text, [
      { range: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } }, newText: "c" },
    ]);
    expect(out).toBe("﻿a\r\nc\r\n");
  });
});
