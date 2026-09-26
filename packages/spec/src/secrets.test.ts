import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { expandTest, mapReader } from "./expand.js";
import { createRng } from "./generators.js";
import { loadTests } from "./node/index.js";
import { parseTest } from "./parse.js";
import { printTest } from "./print.js";

// SEC-1: no API in this package returns a secret value. We plant values where a
// careless implementation might pick them up (process env, .env files in the
// project) and check that none shows up in any output, for many random tests.

const NAMES = ["SHOP_PASSWORD", "ADMIN_TOKEN", "API_KEY", "CARD_PIN"];
const planted = (name: string) => `planted-${name.toLowerCase()}-Zq9!x`;
const saved = new Map<string, string | undefined>();
for (const name of NAMES) {
  saved.set(name, process.env[name]);
  process.env[name] = planted(name);
}
const dirs: string[] = [];
afterAll(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function randomTest(seed: number): { test: string; flow: string } {
  const rng = createRng(String(seed));
  const secret = () => `{{secret.${rng.pick(NAMES)}}}`;
  const lines = [];
  for (let i = 1; i <= 2 + rng.int(6); i++) {
    const kind = rng.int(5);
    if (kind === 0) lines.push(`${i}. Fill "Password" with ${secret()}`);
    else if (kind === 1) lines.push(`${i}. Exact: fill label="Token" with ${secret()}`);
    else if (kind === 2) lines.push(`${i}. Use: flows/f.test.md { pw: "${secret()}" }`);
    else if (kind === 3) lines.push(`${i}. Expect: the key ${secret()} is not shown`);
    else lines.push(`${i}. Type {{data.combo}}`);
  }
  const test = `---\nname: Random ${seed}\ndata:\n  combo: "x-${secret()}-y"\n---\n\n${lines.join("\n")}\n`;
  const flow = `---\nname: F\nkind: flow\nparams:\n  pw: "${secret()}"\n---\n\n1. Fill "PW" with {{params.pw}}\n`;
  return { test, flow };
}

describe("secrets are never resolved", () => {
  it("in parse, expand, print and load output", async () => {
    for (let seed = 0; seed < 60; seed++) {
      const { test, flow } = randomTest(seed);
      const files = { "tests/t.test.md": test, "tests/flows/f.test.md": flow };
      const parsed = parseTest(test, "tests/t.test.md");
      const expanded = await expandTest(parsed.spec, {
        readFile: mapReader(files),
        seed: "s",
        vars: { X: "1" },
      });
      const outputs = JSON.stringify([parsed, expanded, printTest(parsed.spec)]);
      for (const name of NAMES) expect(outputs).not.toContain(planted(name));
      expect(expanded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(expanded.steps.some((s) => s.bound.some((b) => b.kind === "secret"))).toBe(true);
    }
  });

  it("when loading a project that has the values in .env files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spec-secrets-"));
    dirs.push(dir);
    const { test, flow } = randomTest(99);
    const env = NAMES.map((name) => `${name}=${planted(name)}`).join("\n");
    for (const [path, text] of Object.entries({
      "tests/t.test.md": test,
      "tests/flows/f.test.md": flow,
      ".env": env,
      ".env.local": env,
    })) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const loaded = await loadTests(dir, undefined, { environment: "local" });
    const output = JSON.stringify(loaded);
    for (const name of NAMES) expect(output).not.toContain(planted(name));
  });
});
