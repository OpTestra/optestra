import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isPortableSegment,
  isSafeRelativePath,
  isUlid,
  portablePath,
  portableSegment,
  runLayout,
  testIdFromPath,
  ulid,
} from "./index.js";

const SRC = dirname(fileURLToPath(import.meta.url));

/** Every module reachable from `entry` through relative imports, plus the bare imports they make. */
function importGraph(entry: string) {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(
      /(?:import|export)[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g,
    )) {
      const specifier = match[1] ?? match[2] ?? "";
      if (specifier.startsWith(".")) visit(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
      else bare.add(specifier);
    }
  };
  visit(join(SRC, entry));
  return { files, bare };
}

describe("package boundaries", () => {
  it("browser entry imports only zod: no node:, no node entry", () => {
    const { files, bare } = importGraph("index.ts");
    expect([...bare]).toEqual(["zod"]);
    expect([...files].filter((f) => f.startsWith(join(SRC, "node")))).toEqual([]);
  });

  it("depends only on zod", () => {
    const pkg = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["zod"]);
    expect(pkg.peerDependencies).toBeUndefined();
  });
});

describe("ulid", () => {
  it("encodes time first, so ids sort by creation", () => {
    const a = ulid(1_790_000_000_000);
    const b = ulid(1_790_000_000_001);
    expect(isUlid(a) && isUlid(b)).toBe(true);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    expect(ulid(0, (bytes) => bytes.fill(0))).toBe("0".repeat(26));
    expect(isUlid("01M3EF2PM04CMHWHZ9D1V41QWI")).toBe(false);
  });
});

describe("testIdFromPath", () => {
  it("is stable, readable and folder-safe", () => {
    expect(testIdFromPath("tests/checkout/guest.md")).toBe("tests__checkout__guest");
    expect(testIdFromPath("./tests\\checkout\\guest.md")).toBe("tests__checkout__guest");
    expect(testIdFromPath("smoke.test.md")).toBe("smoke.test");
  });

  it("adds a hash when the path had to change, so ids never collide", () => {
    const upper = testIdFromPath("tests/Checkout Flow.md");
    const lower = testIdFromPath("tests/checkout-flow.md");
    expect(upper).toMatch(/^tests__checkout-flow-[0-9a-f]{8}$/);
    expect(lower).toBe("tests__checkout-flow");
    expect(testIdFromPath("tests/checkout flow.md")).not.toBe(upper);
  });
});

describe("portable paths", () => {
  it("rejects names that are invalid on Windows, macOS or Linux", () => {
    for (const bad of [
      "a:b",
      "a<b",
      'a"b',
      "a|b",
      "a?b",
      "a*b",
      "con",
      "NUL.txt",
      "trailing.",
      "trailing ",
    ]) {
      expect(isPortableSegment(bad), bad).toBe(false);
      expect(isSafeRelativePath(`tests/${bad}/result.json`), bad).toBe(false);
    }
    expect(isPortableSegment("tests__checkout__guest")).toBe(true);
  });

  it("makes scrubbed ids and paths portable without touching safe ones", () => {
    expect(portableSegment("login-[secret:ADMIN_PASSWORD]")).toBe("login-[secret-ADMIN_PASSWORD]");
    expect(portableSegment("tests__login")).toBe("tests__login");
    expect(portableSegment("aux")).toBe("_aux");
    expect(portablePath("tests/a:b/1/console.log")).toBe("tests/a-b/1/console.log");
    expect(runLayout.testResult("login-[secret:X]")).toBe("tests/login-[secret-X]/result.json");
    expect(isSafeRelativePath(runLayout.testResult("login-[secret:X]"))).toBe(true);
  });
});
