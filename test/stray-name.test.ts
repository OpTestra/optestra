import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// RENAME-0: the product's old placeholder name is gone. Every name comes from
// packages/brand/brand.json (brand:check guards new literals); this test guards
// the old one, in every tracked file of any kind (docs, fixtures, workflows,
// binaries' text included), case-insensitive.

const root = fileURLToPath(new URL("..", import.meta.url));
/** The old name, spelled so that this file doesn't contain it. */
const OLD = ["test", "ament"].join("");

/** Tracked files that may still name it, and why. Keep this short. */
const ALLOWED = new Map<string, string>([]);

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

describe("the old product name", () => {
  it("appears in no tracked file outside the allowlist", () => {
    const pattern = new RegExp(OLD, "i");
    const found: string[] = [];
    for (const file of tracked) {
      if (ALLOWED.has(file)) continue;
      if (pattern.test(file)) {
        found.push(`${file} (path)`);
        continue;
      }
      let text: string;
      try {
        text = readFileSync(join(root, file)).toString("latin1");
      } catch {
        continue; // deleted in the working tree
      }
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (pattern.test(line)) found.push(`${file}:${i + 1}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("keeps the allowlist explained", () => {
    for (const [file, why] of ALLOWED) expect(why, file).not.toBe("");
  });
});
