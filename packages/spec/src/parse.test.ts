import { describe, expect, it } from "vitest";
import { parseExactOp } from "./exact.js";
import type { ExactOp, Step, TextStep } from "./model.js";
import { specSteps } from "./model.js";
import { parseTest } from "./parse.js";
import { at, codes, file } from "./spec.test-support.js";
import { Reporter, SourceMap } from "./text.js";

const parse = (text: string, path = "tests/t.test.md") => parseTest(text, path);
const steps = (text: string) => specSteps(parse(text).spec);
const text = (step: Step | undefined) => (step as TextStep).text.raw;

describe("frontmatter", () => {
  it("reads every field", () => {
    const { spec, diagnostics } = parse(
      file([
        "name: Checkout works",
        "tags: [smoke, payments]",
        "start: /pricing",
        "auth: none",
        "data:",
        '  email: "{{unique.email}}"',
        "  count: 3",
        "timeout: 90s",
        "heal: strict",
        "allowDestructive: [delete, pay]",
        "dataset: data/users.csv",
        "setup:",
        "  - request: POST /__test/seed",
        "    body: { trial: pro }",
        "    headers: { X-Env: test }",
        "  - run: scripts/seed.sh",
        "teardown:",
        "  - sql: DELETE FROM carts",
        "environments:",
        "  staging:",
        "    start: https://staging.example.com/pricing",
        "    timeout: 5m",
        "    data:",
        "      email: staging@example.com",
      ]),
    );
    expect(diagnostics).toEqual([]);
    const fm = spec.frontmatter;
    expect(fm.name).toBe("Checkout works");
    expect(fm.kind).toBe("test");
    expect(fm.tags).toEqual(["smoke", "payments"]);
    expect(fm.start?.raw).toBe("/pricing");
    expect(fm.auth).toBe("none");
    expect(fm.data.email?.segments).toEqual([
      expect.objectContaining({ kind: "var", ns: "unique", name: "email" }),
    ]);
    expect(fm.data.count?.raw).toBe("3");
    expect(fm.timeout).toBe(90);
    expect(fm.heal).toBe("strict");
    expect(fm.allowDestructive).toEqual(["delete", "pay"]);
    expect(fm.dataset).toBe("data/users.csv");
    expect(fm.setup).toEqual([
      expect.objectContaining({
        type: "request",
        method: "POST",
        target: "/__test/seed",
        body: { trial: "pro" },
        headers: { "X-Env": "test" },
      }),
      expect.objectContaining({ type: "run", script: "scripts/seed.sh" }),
    ]);
    expect(fm.teardown).toEqual([
      expect.objectContaining({ type: "sql", statement: "DELETE FROM carts" }),
    ]);
    expect(fm.environments.staging?.timeout).toBe(300);
    expect(fm.environments.staging?.start?.raw).toBe("https://staging.example.com/pricing");
    expect(fm.environments.staging?.data?.email?.raw).toBe("staging@example.com");
  });

  it("parses durations", () => {
    const timeout = (t: string) =>
      parse(file([`name: x`, `timeout: ${t}`])).spec.frontmatter.timeout;
    expect(timeout("90s")).toBe(90);
    expect(timeout("3m")).toBe(180);
    expect(timeout("1h")).toBe(3600);
    expect(timeout("1.5m")).toBe(90);
  });

  it("reads flows with params (null = required)", () => {
    const { spec, diagnostics } = parse(
      file(
        ["name: Log in", "kind: flow", "params:", "  email:", "  password: pw"],
        "1. Fill {{params.email}}",
      ),
    );
    expect(diagnostics).toEqual([]);
    expect(spec.frontmatter.kind).toBe("flow");
    expect(spec.frontmatter.params.email).toBeNull();
    expect(spec.frontmatter.params.password?.raw).toBe("pw");
  });

  it("keeps unknown keys with a warning", () => {
    const { spec, diagnostics } = parse(file(["name: x", "owner: qa-team"]));
    expect(diagnostics.map(at)).toEqual(["UNKNOWN_KEY@3:1-3:6"]);
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(spec.frontmatter.extra).toEqual({ owner: "qa-team" });
  });

  it("works with CRLF line endings and a byte-order mark", () => {
    const { spec, diagnostics } = parse(
      `﻿${file("name: x", ['1. Click "A"', "2. Expect: b"]).replaceAll("\n", "\r\n")}`,
    );
    expect(diagnostics).toEqual([]);
    expect(specSteps(spec).map((s) => s.kind)).toEqual(["action", "expect"]);
  });
});

describe("body", () => {
  it("maps prefixes to the contract step kinds", () => {
    const list = steps(
      file("name: x", [
        '1. Click "Start"',
        '2. Expect: the heading is "Hi"',
        "3. Soft: the chart looks reasonable",
        '4. Never: click "Delete"',
        "5. Use: flows/login.test.md",
        '6. Exact: click role=button[name="Save"]',
        "7. expect:lower-case prefix works",
      ]),
    );
    expect(list.map((s) => s.kind)).toEqual([
      "action",
      "expect",
      "soft",
      "guard",
      "flow",
      "exact",
      "expect",
    ]);
    expect(list.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(text(list[6])).toBe("lower-case prefix works");
  });

  it("keeps expectations verbatim with their position", () => {
    const [step] = steps(file("name: x", "1. Expect:   the  total is “$90.00”  "));
    expect(text(step)).toBe("the  total is “$90.00”");
    expect(step?.at?.range).toEqual({
      start: { line: 5, column: 1 },
      end: { line: 5, column: 36 },
    });
    expect((step as TextStep).text.at?.range.start).toEqual({ line: 5, column: 14 });
  });

  it("joins indented continuation lines", () => {
    const { spec, diagnostics } = parse(
      file("name: x", [
        "1. Sign up with {{data.email}}",
        "   and the password",
        "     from the vault",
        "2. Next",
      ]),
    );
    expect(codes(diagnostics)).toEqual(["VAR_UNDEFINED"]);
    const [first] = specSteps(spec);
    expect(text(first)).toBe("Sign up with {{data.email}} and the password from the vault");
    expect(first?.at?.range).toEqual({
      start: { line: 5, column: 1 },
      end: { line: 7, column: 20 },
    });
    // A variable on a continuation line maps back to its own line.
    const multi = steps(file("name: x", ["1. Sign up", "   with {{unique.email}}"]))[0] as TextStep;
    expect(multi.text.segments[1]).toMatchObject({
      kind: "var",
      at: { range: { start: { line: 6, column: 9 } } },
    });
  });

  it("accepts guards numbered or unnumbered, anywhere", () => {
    const list = steps(
      file("name: x", [
        'Never: click "Delete account"',
        "1. Go",
        "",
        'Never: click "Pay"',
        "2. Stop",
        "3. Never: send email",
      ]),
    );
    expect(list.map((s) => [s.kind, s.number])).toEqual([
      ["guard", null],
      ["action", 1],
      ["guard", null],
      ["action", 2],
      ["guard", 3],
    ]);
  });

  it("warns about out-of-order numbers but keeps them", () => {
    const { spec, diagnostics } = parse(file("name: x", ["1. a", "3. b", "2. c", "3. d"]));
    expect(diagnostics.map(at)).toEqual(["STEP_NUMBER_ORDER@6:1-6:3", "STEP_NUMBER_ORDER@7:1-7:3"]);
    expect(specSteps(spec).map((s) => s.number)).toEqual([1, 3, 2, 3]);
  });

  it("keeps comments, blank lines and stray text in order", () => {
    const { spec, diagnostics } = parse(
      file("name: x", [
        "<!-- Login first",
        "     then check -->",
        "1. a",
        "",
        "",
        "Some notes",
        "2. b",
      ]),
    );
    expect(diagnostics.map(at)).toEqual(["TEXT_OUTSIDE_STEPS@10:1-10:11"]);
    expect(spec.body.map((i) => i.type)).toEqual(["comment", "step", "blank", "text", "step"]);
  });

  it("suggests numbering an unnumbered expectation", () => {
    const { diagnostics } = parse(file("name: x", ["1. a", "Expect: b"]));
    expect(diagnostics[0]).toMatchObject({
      code: "TEXT_OUTSIDE_STEPS",
      fix: expect.stringContaining('"2. Expect: b"'),
    });
  });

  it("reads Use: with inline params", () => {
    const [step] = steps(
      file("name: x", '1. Use: flows/login.test.md { email: "{{unique.email}}", password: pw }'),
    );
    expect(step).toMatchObject({ kind: "flow", path: "flows/login.test.md" });
    if (step?.kind !== "flow") throw new Error("not a flow step");
    expect(step.params.email?.segments[0]).toMatchObject({
      kind: "var",
      ns: "unique",
      at: { range: { start: { line: 5, column: 39 } } },
    });
    expect(step.params.password?.raw).toBe("pw");
    expect(step.at?.path).toEqual({ start: { line: 5, column: 9 }, end: { line: 5, column: 28 } });
  });
});

describe("exact steps", () => {
  it("reads a fenced ts block after the step line, verbatim", () => {
    const [step] = steps(
      file("name: x", [
        "1. Pick a date",
        "   ```ts",
        "   await page.fill('#d', '2024-01-01');",
        "",
        "     // indented",
        "   ```",
        "2. b",
      ]),
    );
    expect(step).toMatchObject({
      kind: "exact",
      exact: {
        form: "code",
        lang: "ts",
        label: "Pick a date",
        code: "await page.fill('#d', '2024-01-01');\n\n  // indented",
      },
    });
  });

  it("reads a fence on the step line", () => {
    const [step] = steps(file("name: x", ["1. ```ts", "   await page.reload();", "   ```"]));
    expect(step).toMatchObject({
      kind: "exact",
      exact: { form: "code", code: "await page.reload();" },
    });
    expect(step?.kind === "exact" && step.exact.form === "code" && step.exact.label).toBeFalsy();
  });

  const ops: [string, ExactOp | Record<string, unknown>][] = [
    ["goto /pricing", { op: "goto", url: { raw: "/pricing" } }],
    ['goto "https://x.test/a b"', { op: "goto", url: { raw: "https://x.test/a b" } }],
    [
      'click role=button[name="Save"]',
      { op: "click", target: { by: "role", role: "button", name: "Save" } },
    ],
    ["click role=heading", { op: "click", target: { by: "role", role: "heading" } }],
    ["click testid=save", { op: "click", target: { by: "testid", value: "save" } }],
    ['click text="Save \\"all\\""', { op: "click", target: { by: "text", value: 'Save "all"' } }],
    ["click css=.btn.primary", { op: "click", target: { by: "css", value: ".btn.primary" } }],
    [
      'fill label="Email" with {{data.email}}',
      { op: "fill", target: { by: "label", value: "Email" }, value: { raw: "{{data.email}}" } },
    ],
    [
      'fill placeholder="Search" with "red shoes"',
      { op: "fill", target: { by: "placeholder", value: "Search" }, value: { raw: "red shoes" } },
    ],
    [
      'select "Europe/London" in label="Time zone"',
      {
        op: "select",
        option: { raw: "Europe/London" },
        target: { by: "label", value: "Time zone" },
      },
    ],
    [
      "select Large size in testid=size",
      { op: "select", option: { raw: "Large size" }, target: { by: "testid", value: "size" } },
    ],
    ["press Enter", { op: "press", key: "Enter" }],
    ["press Control+A", { op: "press", key: "Control+A" }],
    [
      "expect url contains /dashboard",
      { op: "expectUrl", match: "contains", value: { raw: "/dashboard" } },
    ],
    [
      "expect url is https://x.test/",
      { op: "expectUrl", match: "is", value: { raw: "https://x.test/" } },
    ],
    [
      'expect role=heading text "Welcome"',
      {
        op: "expectText",
        match: "text",
        target: { by: "role", role: "heading" },
        value: { raw: "Welcome" },
      },
    ],
    [
      'expect testid=total contains "$90"',
      {
        op: "expectText",
        match: "contains",
        target: { by: "testid", value: "total" },
        value: { raw: "$90" },
      },
    ],
    [
      'expect text="Saved" visible',
      { op: "expectState", state: "visible", target: { by: "text", value: "Saved" } },
    ],
    ['expect label="Email" hidden', { op: "expectState", state: "hidden" }],
    ['expect role=button[name="Pay"] enabled', { op: "expectState", state: "enabled" }],
    ['expect role=button[name="Pay"] disabled', { op: "expectState", state: "disabled" }],
    [
      "expect css=.row count 5",
      { op: "expectCount", count: 5, target: { by: "css", value: ".row" } },
    ],
  ];
  it.each(ops)("parses Exact: %s", (source, expected) => {
    const report = new Reporter("t");
    const op = parseExactOp(source, SourceMap.at(1, 1), report);
    expect(report.diagnostics).toEqual([]);
    expect(op).toMatchObject(expected);
  });

  const bad: [string, number, number][] = [
    ["jump over", 1, 5],
    ['click button="Save"', 7, 20],
    ["click", 6, 6],
    ['fill label="Email" to x', 20, 22],
    ['fill label="Email with x', 12, 25],
    ["press Ctrl A", 12, 13],
    ["press Ctrl-A!", 7, 14],
    ['expect text="x" shiny', 17, 22],
    ['expect text="x" count many', 23, 27],
    ['expect text="x" text Saved', 22, 27],
    ["expect url has /x", 12, 15],
    ['click role=button[title="x"]', 19, 29],
  ];
  it.each(bad)("reports EXACT_SYNTAX at the exact spot: %s", (source, start, end) => {
    const report = new Reporter("t");
    expect(parseExactOp(source, SourceMap.at(3, 1), report)).toBeUndefined();
    expect(report.diagnostics.map(at)).toEqual([`EXACT_SYNTAX@3:${start}-3:${end}`]);
  });

  it("positions EXACT_SYNTAX in the file", () => {
    const { spec, diagnostics } = parse(file("name: x", ["1. a", '2. Exact: click button="Save"']));
    expect(diagnostics.map(at)).toEqual(["EXACT_SYNTAX@6:17-6:30"]);
    // The broken step is kept as text so printing never loses it.
    expect(spec.body.map((i) => i.type)).toEqual(["step", "text"]);
  });
});

describe("templates", () => {
  const refs = (raw: string) => {
    const [step] = steps(file(["name: x", "data:", "  x: 1"], `1. ${raw}`));
    return (step as TextStep).text.segments;
  };

  it("allows spacing inside the braces", () => {
    expect(refs("a {{ data.x }} b")).toEqual([
      { kind: "text", text: "a " },
      expect.objectContaining({ kind: "var", ns: "data", name: "x", raw: "{{ data.x }}" }),
      { kind: "text", text: " b" },
    ]);
  });

  it("treats \\{{ as literal braces", () => {
    expect(refs("type \\{{data.x}} literally")).toEqual([
      { kind: "text", text: "type {{data.x}} literally" },
    ]);
  });

  it("reports an unclosed {{ and bad references", () => {
    const { diagnostics } = parse(
      file(
        ["name: x", "data:", "  x: 1"],
        ["1. a {{data.x b", "2. {{data}} and {{data.x.y}} and {{}}"],
      ),
    );
    expect(diagnostics.map(at)).toEqual([
      "TEMPLATE_UNCLOSED@7:6-7:16",
      "TEMPLATE_SYNTAX@8:4-8:12",
      "TEMPLATE_SYNTAX@8:17-8:29",
      "TEMPLATE_SYNTAX@8:34-8:38",
    ]);
  });

  it("checks namespaces, members, data, params and secrets", () => {
    const { diagnostics } = parseTest(
      file(
        ["name: x", "data:", "  a: 1"],
        [
          "1. {{nope.x}}",
          "2. {{unique.phone}} {{faker.color}}",
          "3. {{data.b}}",
          "4. {{params.a}}",
          "5. {{secret.lower}} {{secret.OTHER}} {{secret.KNOWN}}",
          "6. {{env.ANY}} {{faker.city}} {{unique.email}}",
        ],
      ),
      "tests/t.test.md",
      { config: { secrets: { KNOWN: { domains: ["x.test"] } }, environments: {} } },
    );
    expect(diagnostics.map(at)).toEqual([
      "VAR_NAMESPACE_UNKNOWN@7:4-7:14",
      "VAR_MEMBER_UNKNOWN@8:4-8:20",
      "VAR_MEMBER_UNKNOWN@8:21-8:36",
      "VAR_UNDEFINED@9:4-9:14",
      "PARAMS_OUTSIDE_FLOW@10:4-10:16",
      "SECRET_NAME_INVALID@11:4-11:20",
      "SECRET_UNDECLARED@11:21-11:37",
    ]);
  });

  it("does not check secrets when no config is given", () => {
    expect(parse(file("name: x", "1. Type {{secret.ANY_NAME}}")).diagnostics).toEqual([]);
  });

  it("positions references inside frontmatter values", () => {
    const { diagnostics } = parse(
      file(["name: x", "data:", '  a: "{{data.missing}}"', "  b: plain {{nope.x}}"]),
    );
    expect(diagnostics.map(at)).toEqual([
      "VAR_UNDEFINED@4:7-4:23",
      "VAR_NAMESPACE_UNKNOWN@5:12-5:22",
    ]);
  });

  it("finds data cycles", () => {
    const { diagnostics } = parse(
      file([
        "name: x",
        "data:",
        '  a: "{{data.b}}"',
        '  b: "x{{data.c}}"',
        '  c: "{{data.a}}"',
        '  d: "{{data.d}}"',
        '  e: "{{data.a}}"',
      ]),
    );
    expect(codes(diagnostics)).toEqual(["DATA_CYCLE", "DATA_CYCLE"]);
    expect(diagnostics[0]?.message).toContain("data.a → data.b → data.c → data.a");
    expect(diagnostics[1]?.message).toContain("data.d → data.d");
  });
});

describe("diagnostic codes", () => {
  const cases: [string, string, string?][] = [
    ["FRONTMATTER_MISSING", "1. Click"],
    ["FRONTMATTER_UNCLOSED", "---\nname: x\n1. Click"],
    ["YAML_SYNTAX", file(["name: x", "tags: [a"])],
    ["YAML_DUPLICATE_KEY", file(["name: x", "name: y"])],
    ["FRONTMATTER_NOT_OBJECT", file("- a list")],
    ["UNKNOWN_KEY", file(["name: x", "color: red"])],
    ["REQUIRED_MISSING", file("tags: [a]")],
    ["INVALID_VALUE", file(["name: x", "timeout: 90"])],
    ["INVALID_VALUE", file(["name: x", "tags: smoke"])],
    ["INVALID_VALUE", file(["name: x", "heal: sometimes"])],
    ["INVALID_VALUE", file(["name: x", "allowDestructive: [explode]"])],
    ["INVALID_VALUE", file(["name: x", "dataset: users.xlsx"])],
    ["INVALID_VALUE", file(["name: x", "kind: suite"])],
    ["INVALID_VALUE", file(["name: x", "data:", "  1bad: x"])],
    ["INVALID_VALUE", file(["name: x", "data:", "  a: [1, 2]"])],
    ["HOOK_INVALID", file(["name: x", "setup:", "  - request: FETCH /x"])],
    ["HOOK_INVALID", file(["name: x", "setup:", "  - request: POST x"])],
    ["HOOK_INVALID", file(["name: x", "setup:", "  - run: a", "    sql: b"])],
    ["HOOK_INVALID", file(["name: x", "setup: POST /x"])],
    ["PARAMS_OUTSIDE_FLOW", file(["name: x", "params:", "  a: 1"])],
    ["NO_STEPS", file("name: x", "")],
    ["TEXT_OUTSIDE_STEPS", file("name: x", ["1. a", "# Heading"])],
    ["STEP_NUMBER_ORDER", file("name: x", ["2. a"])],
    ["STEP_EMPTY", file("name: x", ["1. a", "2. Expect:"])],
    ["USE_SYNTAX", file("name: x", ["1. Use: flows/a.test.md email=x"])],
    ["USE_SYNTAX", file("name: x", ["1. Use: flows/a.test.md { email: [1] }"])],
    ["EXACT_SYNTAX", file("name: x", ["1. Exact: hover text=x"])],
    ["EXACT_CODE_LANG", file("name: x", ["1. Do it", "   ```python", "   pass", "   ```"])],
    ["FENCE_UNCLOSED", file("name: x", ["1. Do it", "   ```ts", "   x()"])],
    ["TEMPLATE_UNCLOSED", file("name: x", "1. {{data.x")],
    ["TEMPLATE_SYNTAX", file("name: x", "1. {{ nothing }}")],
    ["VAR_NAMESPACE_UNKNOWN", file("name: x", "1. {{user.name}}")],
    ["VAR_MEMBER_UNKNOWN", file("name: x", "1. {{unique.phone}}")],
    ["VAR_UNDEFINED", file("name: x", "1. {{data.x}}")],
    ["SECRET_NAME_INVALID", file("name: x", "1. {{secret.password}}")],
    ["DATA_CYCLE", file(["name: x", "data:", '  a: "{{data.a}}"'])],
  ];

  it.each(cases)("%s", (code, source) => {
    const { diagnostics } = parse(source);
    const found = diagnostics.find((d) => d.code === code);
    expect(found, JSON.stringify(diagnostics, null, 2)).toBeDefined();
    expect(found?.file).toBe("tests/t.test.md");
    expect(found?.message.length).toBeGreaterThan(10);
    expect(found?.fix.length).toBeGreaterThan(5);
    expect(found?.range?.start.line).toBeGreaterThan(0);
    expect(found?.line).toBe(found?.range?.start.line);
  });

  it("warnings are warnings", () => {
    const severity = (source: string, code: string) =>
      parse(source).diagnostics.find((d) => d.code === code)?.severity;
    expect(severity(file(["name: x", "color: red"]), "UNKNOWN_KEY")).toBe("warning");
    expect(severity(file("name: x", ["2. a"]), "STEP_NUMBER_ORDER")).toBe("warning");
    expect(severity(file("name: x", ["1. a", "note"]), "TEXT_OUTSIDE_STEPS")).toBe("warning");
    expect(severity(file("name: x", ""), "NO_STEPS")).toBe("warning");
  });
});

describe("robustness", () => {
  it("never throws, whatever the input", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pieces = [
      "---",
      "name: x",
      "1. ",
      "Expect:",
      "Use:",
      "Exact:",
      "```ts",
      "```",
      "{{",
      "}}",
      "data.",
      "<!--",
      "-->",
      "  ",
      "\n",
      "click ",
      'role=button[name="',
      "\t",
      "Never:",
      "params:",
      "  a:",
      "- ",
      ": ",
      "[",
      "{",
    ];
    for (let i = 0; i < 400; i++) {
      let text = "";
      const length = rand(40);
      for (let j = 0; j < length; j++) text += pieces[rand(pieces.length)];
      expect(() => parse(text)).not.toThrow();
    }
  });
});
