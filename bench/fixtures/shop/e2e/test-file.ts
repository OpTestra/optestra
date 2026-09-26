import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Just enough of the application.md 6.4 format for the reference suite: the
// real parser arrives in SPEC. The suite reads step text and setup from here,
// so the .test.md files stay the single source for both.

export const TESTS_DIR = fileURLToPath(new URL("../tests/", import.meta.url));

export interface SetupCall {
  method: "POST" | "GET";
  path: string;
  body?: unknown;
}

export interface TestFile {
  name: string;
  frontmatter: Record<string, unknown>;
  start: string;
  setup: SetupCall[];
  steps: Map<number, string>;
  never: string[];
}

export function parseTestFile(source: string, name: string): TestFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`${name}: missing frontmatter`);
  const frontmatter = (parse(match[1] ?? "") ?? {}) as Record<string, unknown>;
  const steps = new Map<number, string>();
  const never: string[] = [];
  for (const line of (match[2] ?? "").split(/\r?\n/)) {
    const step = /^(\d+)\.\s+(.+)$/.exec(line);
    if (step) {
      const n = Number(step[1]);
      if (n !== steps.size + 1) throw new Error(`${name}: step ${n} is out of order`);
      steps.set(n, (step[2] ?? "").trim());
    }
    const guard = /^Never:\s*(.+)$/.exec(line);
    if (guard) never.push((guard[1] ?? "").trim());
  }
  const setup = ((frontmatter.setup ?? []) as Array<{ request: string; body?: unknown }>).map(
    (call): SetupCall => {
      const [method, path] = call.request.split(/\s+/);
      if ((method !== "POST" && method !== "GET") || !path) {
        throw new Error(`${name}: bad setup request "${call.request}"`);
      }
      return call.body === undefined ? { method, path } : { method, path, body: call.body };
    },
  );
  return {
    name,
    frontmatter,
    start: typeof frontmatter.start === "string" ? frontmatter.start : "/",
    setup,
    steps,
    never,
  };
}

/** `name` is the path under tests/ without `.test.md`, e.g. "login" or "flows/login". */
export function readTestFile(name: string): TestFile {
  return parseTestFile(readFileSync(`${TESTS_DIR}${name}.test.md`, "utf8"), name);
}
