import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseTest } from "../parse.js";
import { printTest } from "../print.js";
import { loadDataset, parseCsv } from "./dataset.js";
import { loadTest } from "./index.js";

// Datasets (AUT-9): rows from CSV or JSON, bound as {{data.<column>}}; every
// problem a diagnostic that says what to fix.

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dataset-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe("parseCsv", () => {
  it("reads quotes, commas, doubled quotes, CRLF and newlines in quotes", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\nlines",3\n\n')).toEqual({
      rows: [
        ["a", "b"],
        ["x, y", 'say "hi"'],
        ["two\nlines", "3"],
      ],
    });
    expect(parseCsv('a\n"open').error).toBe("a quoted field is never closed");
  });
});

describe("loadDataset", () => {
  it("loads CSV and JSON rows relative to the test file", () => {
    const dir = project({
      "tests/data/plans.csv": "plan,price\nPro,$29.00\nTeam,$99.00\n",
      "tests/data/users.json": JSON.stringify([
        { email: "ada@example.com", admin: true },
        { email: "{{unique.email}}", admin: false },
      ]),
    });
    expect(loadDataset(dir, "tests/checkout.test.md", "data/plans.csv")).toEqual({
      path: "tests/data/plans.csv",
      columns: ["plan", "price"],
      rows: [
        { row: 1, values: { plan: "Pro", price: "$29.00" } },
        { row: 2, values: { plan: "Team", price: "$99.00" } },
      ],
      diagnostics: [],
    });
    expect(loadDataset(dir, "tests/x.test.md", "data/users.json").rows[1]?.values).toEqual({
      email: "{{unique.email}}",
      admin: "false",
    });
  });

  it("says what is wrong", () => {
    const dir = project({
      "tests/short.csv": "a,b\n1\n",
      "tests/empty.csv": "a,b\n",
      "tests/bad-name.csv": "first name\nAda\n",
      "tests/nested.json": '[{"a": {"b": 1}}]',
      "tests/uneven.json": '[{"a": 1}, {"b": 2}]',
      "tests/object.json": '{"a": 1}',
    });
    const code = (file: string) => {
      const loaded = loadDataset(dir, "tests/t.test.md", file);
      expect(loaded.rows).toEqual([]);
      return [loaded.diagnostics[0]?.code, loaded.diagnostics[0]?.message];
    };
    expect(code("short.csv")).toEqual([
      "DATASET_INVALID",
      "tests/short.csv row 1 has 1 values; the header has 2 columns.",
    ]);
    expect(code("empty.csv")).toEqual(["DATASET_EMPTY", "tests/empty.csv has no rows."]);
    expect(code("bad-name.csv")?.[1]).toContain(
      '"first name" can\'t be used as {{data.first name}}',
    );
    expect(code("nested.json")?.[1]).toContain('"a" is not text, a number or true/false');
    expect(code("uneven.json")?.[1]).toContain('row 1 has no "b"');
    expect(code("object.json")?.[1]).toContain("must be a JSON array");
    expect(code("missing.csv")?.[0]).toBe("DATASET_NOT_FOUND");
    expect(code("../../etc/x.csv")?.[1]).toContain("outside the project folder");
    expect(code("plans.xlsx")?.[1]).toContain("neither .csv nor .json");
  });
});

describe("a dataset row in the test", () => {
  it("binds {{data.<column>}}, replacing a frontmatter value", async () => {
    const dir = project({
      "tests/t.test.md":
        '---\nname: T\nstart: /\ndataset: rows.csv\ndata:\n  plan: Free\n---\n\n1. Click {{data.plan}}\n2. Expect: the page shows "{{data.price}}"\n',
    });
    const loaded = await loadTest(dir, "tests/t.test.md", undefined, {
      data: { plan: "Pro", price: "$29.00" },
    });
    expect(loaded?.expanded.dataset).toBe("rows.csv");
    expect(loaded?.expanded.steps.map((s) => s.display)).toEqual([
      "Click Pro",
      'the page shows "$29.00"',
    ]);
    // The text keys don't depend on the row: every row shares one recording.
    const other = await loadTest(dir, "tests/t.test.md", undefined, {
      data: { plan: "Team", price: "$99.00" },
    });
    expect(other?.expanded.steps.map((s) => s.textKey)).toEqual(
      loaded?.expanded.steps.map((s) => s.textKey),
    );
  });
});

describe("sql hooks", () => {
  it("keep production: true when printed", () => {
    const text =
      '---\nname: T\nsetup:\n  - sql: DELETE FROM carts\n    production: true\n  - sql: SELECT 1\n---\n\n1. Expect: the page shows "x"\n';
    const { spec, diagnostics } = parseTest(text, "tests/t.test.md");
    expect(diagnostics).toEqual([]);
    expect(spec.frontmatter.setup).toMatchObject([
      { type: "sql", statement: "DELETE FROM carts", production: true },
      { type: "sql", statement: "SELECT 1" },
    ]);
    expect(printTest(spec)).toBe(text);
    const bad = parseTest(text.replace("production: true", "production: yes"), "tests/t.test.md");
    expect(bad.diagnostics.map((d) => d.code)).toContain("HOOK_INVALID");
  });
});
