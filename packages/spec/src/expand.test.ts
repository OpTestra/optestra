import { describe, expect, it } from "vitest";
import { type ExpandContext, expandTest, flowCandidates, mapReader } from "./expand.js";
import { GeneratorRegistry } from "./generators.js";
import { parseTest } from "./parse.js";
import { at, codes, file } from "./spec.test-support.js";

const LOGIN = file(
  [
    "name: Log in",
    "kind: flow",
    "params:",
    "  email: ada@example.com",
    '  password: "{{secret.SHOP_PASSWORD}}"',
    "start: /login",
  ],
  [
    "1. Go to /login",
    '2. Fill "Email" with {{params.email}}',
    '3. Fill "Password" with {{params.password}}',
    '4. Click "Log in"',
    '5. Expect: the page heading is "Dashboard"',
    "",
    'Never: click "Delete account"',
  ],
);

async function expand(
  files: Record<string, string>,
  path: string,
  ctx: Partial<ExpandContext> = {},
) {
  const text = files[path] ?? "";
  const parsed = parseTest(text, path);
  const expanded = await expandTest(parsed.spec, {
    readFile: mapReader(files),
    seed: "s1",
    ...ctx,
  });
  return { parsed, expanded };
}

describe("flows", () => {
  it("inlines a flow with defaults, keeping each step's origin", async () => {
    const { expanded } = await expand(
      {
        "tests/flows/login.test.md": LOGIN,
        "tests/a.test.md": file("name: A", ["1. Use: flows/login.test.md", '2. Click "Create"']),
      },
      "tests/a.test.md",
    );
    expect(expanded.diagnostics).toEqual([]);
    expect(expanded.steps.map((s) => s.display)).toEqual([
      "Go to /login",
      'Fill "Email" with ada@example.com',
      'Fill "Password" with {{secret.SHOP_PASSWORD}}',
      'Click "Log in"',
      'the page heading is "Dashboard"',
      'Click "Create"',
    ]);
    expect(expanded.steps[1]).toMatchObject({
      text: 'Fill "Email" with {{params.email}}',
      bound: [
        { kind: "text", text: 'Fill "Email" with ' },
        { kind: "value", ref: "params.email", text: "ada@example.com" },
      ],
      flowPath: ["tests/flows/login.test.md"],
      origin: [
        { file: "tests/a.test.md", line: 5, number: 1 },
        { file: "tests/flows/login.test.md", line: 11, number: 2 },
      ],
    });
    expect(expanded.steps[2]?.bound[1]).toEqual({ kind: "secret", name: "SHOP_PASSWORD" });
    expect(expanded.steps[5]).toMatchObject({
      flowPath: [],
      origin: [{ file: "tests/a.test.md", line: 6 }],
    });
    // The flow's own start is ignored when included; its guards join the test.
    expect(expanded.start).toBeNull();
    expect(expanded.guards.map((g) => [g.display, g.flowPath])).toEqual([
      ['click "Delete account"', ["tests/flows/login.test.md"]],
    ]);
    expect(expanded.files).toEqual(["tests/a.test.md", "tests/flows/login.test.md"]);
  });

  it("binds caller params in the caller's scope; they override defaults", async () => {
    const { expanded } = await expand(
      {
        "tests/flows/login.test.md": LOGIN,
        "tests/a.test.md": file(
          ["name: A", "data:", "  admin: admin@example.com"],
          '1. Use: flows/login.test.md { email: "{{data.admin}}", password: "{{secret.ADMIN_PASSWORD}}" }',
        ),
      },
      "tests/a.test.md",
    );
    expect(expanded.diagnostics).toEqual([]);
    expect(expanded.steps[1]?.bound[1]).toEqual({
      kind: "value",
      ref: "params.email",
      text: "admin@example.com",
    });
    expect(expanded.steps[2]?.bound[1]).toEqual({ kind: "secret", name: "ADMIN_PASSWORD" });
  });

  it("resolves paths relative to the file, then the tests root", () => {
    expect(flowCandidates("tests/checkout/a.test.md", "flows/x.test.md", "tests")).toEqual([
      "tests/checkout/flows/x.test.md",
      "tests/flows/x.test.md",
    ]);
    expect(flowCandidates("tests/checkout/a.test.md", "../flows/x.test.md", "tests")).toEqual([
      "tests/flows/x.test.md",
      "flows/x.test.md",
    ]);
    expect(flowCandidates("tests/a.test.md", "/shared/x.test.md", "tests")).toEqual([
      "shared/x.test.md",
    ]);
    expect(flowCandidates("tests/a.test.md", "../../../x.test.md", "tests")).toEqual([]);
  });

  it("falls back to the tests root", async () => {
    const { expanded } = await expand(
      {
        "tests/flows/login.test.md": LOGIN,
        "tests/deep/a.test.md": file("name: A", "1. Use: flows/login.test.md"),
      },
      "tests/deep/a.test.md",
    );
    expect(expanded.diagnostics).toEqual([]);
    expect(expanded.steps).toHaveLength(5);
  });

  it("reports missing flows, required and unknown params with positions", async () => {
    const flow = file(
      ["name: F", "kind: flow", "params:", "  email:", "  name: Ada"],
      "1. Hi {{params.name}} {{params.email}}",
    );
    const { expanded } = await expand(
      {
        "tests/flows/f.test.md": flow,
        "tests/a.test.md": file("name: A", [
          "1. Use: flows/nope.test.md",
          "2. Use: flows/f.test.md",
          "3. Use: flows/f.test.md { email: a@b.test, color: red }",
        ]),
      },
      "tests/a.test.md",
    );
    expect(expanded.diagnostics.map(at)).toEqual([
      "FLOW_NOT_FOUND@5:9-5:27",
      "FLOW_PARAM_MISSING@6:1-6:24",
      "FLOW_PARAM_UNKNOWN@7:51-7:54",
    ]);
    expect(expanded.steps.map((s) => s.display)).toEqual([
      "Hi Ada {{params.email}}",
      "Hi Ada a@b.test",
    ]);
  });

  it("detects cycles and a flow that is really a test", async () => {
    const files = {
      "tests/flows/a.test.md": file(["name: A", "kind: flow"], ["1. one", "2. Use: b.test.md"]),
      "tests/flows/b.test.md": file(["name: B", "kind: flow"], ["1. two", "2. Use: a.test.md"]),
      "tests/other.test.md": file("name: Other"),
      "tests/t.test.md": file("name: T", ["1. Use: flows/a.test.md", "2. Use: other.test.md"]),
    };
    const { expanded } = await expand(files, "tests/t.test.md");
    // Sorted by file: the cycle is reported where it closes (b), the test problem in t.
    expect(expanded.diagnostics.map((d) => [d.code, d.file])).toEqual([
      ["FLOW_CYCLE", "tests/flows/b.test.md"],
      ["FLOW_NOT_A_FLOW", "tests/t.test.md"],
    ]);
    expect(expanded.diagnostics[0]?.message).toContain(
      "tests/t.test.md → tests/flows/a.test.md → tests/flows/b.test.md → tests/flows/a.test.md",
    );
    expect(expanded.steps.map((s) => s.display)).toEqual(["one", "two"]);
  });

  it("limits nesting depth", async () => {
    const files: Record<string, string> = {
      "tests/t.test.md": file("name: T", "1. Use: f0.test.md"),
    };
    for (let i = 0; i < 12; i++) {
      files[`tests/f${i}.test.md`] = file(
        [`name: F${i}`, "kind: flow"],
        [`1. step ${i}`, `2. Use: f${i + 1}.test.md`],
      );
    }
    files["tests/f12.test.md"] = file(["name: F12", "kind: flow"], "1. last");
    const { expanded } = await expand(files, "tests/t.test.md", { maxDepth: 3 });
    expect(codes(expanded.diagnostics)).toEqual(["FLOW_DEPTH"]);
    expect(expanded.steps.map((s) => s.display)).toEqual(["step 0", "step 1", "step 2"]);
  });

  it("includes a flow's own parse problems once", async () => {
    const broken = file(["name: B", "kind: flow"], ["1. {{data.nope}}"]);
    const { expanded } = await expand(
      {
        "tests/b.test.md": broken,
        "tests/t.test.md": file("name: T", ["1. Use: b.test.md", "2. Use: b.test.md"]),
      },
      "tests/t.test.md",
    );
    expect(expanded.diagnostics.map((d) => [d.code, d.file])).toEqual([
      ["VAR_UNDEFINED", "tests/b.test.md"],
    ]);
  });

  it("runs a flow on its own from its defaults and its own start", async () => {
    const { expanded } = await expand(
      { "tests/flows/login.test.md": LOGIN },
      "tests/flows/login.test.md",
    );
    expect(expanded.kind).toBe("flow");
    expect(expanded.start?.display).toBe("/login");
    expect(expanded.params.email?.display).toBe("ada@example.com");
    expect(expanded.params.password?.display).toBe("{{secret.SHOP_PASSWORD}}");
    const required = await expand(
      {
        "tests/f.test.md": file(
          ["name: F", "kind: flow", "params:", "  email:"],
          "1. {{params.email}}",
        ),
      },
      "tests/f.test.md",
    );
    expect(required.expanded.diagnostics.map(at)).toEqual(["FLOW_PARAM_MISSING@5:3-5:9"]);
  });
});

describe("variables", () => {
  it("resolves data in dependency order", async () => {
    const { expanded } = await expand(
      {
        "tests/t.test.md": file(
          [
            "name: T",
            "data:",
            '  greeting: "Hi {{data.name}} at {{data.email}}"',
            '  name: "{{faker.firstName}}"',
            '  email: "{{unique.email}}"',
          ],
          "1. Say {{data.greeting}}",
        ),
      },
      "tests/t.test.md",
    );
    const { name, email, greeting } = expanded.data;
    expect(greeting?.display).toBe(`Hi ${name?.display} at ${email?.display}`);
    expect(email?.display).toMatch(/^test-[0-9a-z]{10}@example\.test$/);
    expect(expanded.steps[0]?.display).toBe(`Say ${greeting?.display}`);
  });

  it("applies environment overrides of start, data and timeout", async () => {
    const files = {
      "tests/t.test.md": file(
        [
          "name: T",
          "start: /pricing",
          "timeout: 1m",
          "data:",
          "  user: dev@example.com",
          "environments:",
          "  staging:",
          "    start: https://staging.example.com/pricing",
          "    timeout: 5m",
          "    data:",
          "      user: stage@example.com",
        ],
        "1. Log in as {{data.user}}",
      ),
    };
    const plain = await expand(files, "tests/t.test.md");
    expect([
      plain.expanded.start?.display,
      plain.expanded.timeout,
      plain.expanded.steps[0]?.display,
    ]).toEqual(["/pricing", 60, "Log in as dev@example.com"]);
    const staging = await expand(files, "tests/t.test.md", { environment: "staging" });
    expect([
      staging.expanded.start?.display,
      staging.expanded.timeout,
      staging.expanded.steps[0]?.display,
    ]).toEqual(["https://staging.example.com/pricing", 300, "Log in as stage@example.com"]);
  });

  it("binds env vars when given, and reports unknown ones", async () => {
    const files = {
      "tests/t.test.md": file("name: T", "1. Open {{env.SHOP_URL}} and {{env.NOPE}}"),
    };
    const unresolved = await expand(files, "tests/t.test.md");
    expect(unresolved.expanded.diagnostics).toEqual([]);
    expect(unresolved.expanded.steps[0]?.bound[1]).toEqual({
      kind: "unresolved",
      ref: "env.SHOP_URL",
    });
    const bound = await expand(files, "tests/t.test.md", {
      vars: { SHOP_URL: "http://x.test" },
      environment: "local",
    });
    expect(bound.expanded.steps[0]?.display).toBe("Open http://x.test and {{env.NOPE}}");
    expect(bound.expanded.diagnostics.map(at)).toEqual(["ENV_UNDEFINED@5:30-5:42"]);
  });

  it("binds values inside exact ops", async () => {
    const { expanded } = await expand(
      {
        "tests/t.test.md": file(
          ["name: T", "data:", "  user: ada@example.com"],
          [
            '1. Exact: fill label="Email" with {{data.user}}',
            '2. Exact: fill label="Password" with {{secret.PW}}',
          ],
        ),
      },
      "tests/t.test.md",
    );
    expect(expanded.steps.map((s) => s.display)).toEqual([
      'fill label="Email" with "ada@example.com"',
      'fill label="Password" with "{{secret.PW}}"',
    ]);
    expect(expanded.steps[1]?.bound).toContainEqual({ kind: "secret", name: "PW" });
    expect(expanded.steps[0]?.exact).toMatchObject({
      form: "op",
      op: { op: "fill", value: { display: "ada@example.com" } },
    });
  });
});

describe("generators (ENV-3)", () => {
  const files = {
    "tests/t.test.md": file(
      [
        "name: T",
        "data:",
        '  email: "{{unique.email}}"',
        '  id: "{{unique.id}}"',
        '  who: "{{unique.name}}"',
      ],
      [
        "1. {{faker.name}} {{faker.firstName}} {{faker.lastName}}",
        "2. {{faker.email}} {{faker.company}} {{faker.phone}} {{faker.city}}",
      ],
    ),
  };
  const values = async (seed: string) => {
    const { expanded } = await expand(files, "tests/t.test.md", { seed });
    return [
      ...Object.values(expanded.data).map((v) => v.display),
      ...expanded.steps.map((s) => s.display),
    ];
  };

  it("is deterministic per seed and differs across seeds", async () => {
    expect(await values("run-1/worker-0")).toEqual(await values("run-1/worker-0"));
    const [a, b] = [await values("run-1/worker-0"), await values("run-1/worker-1")];
    expect(a[0]).not.toBe(b[0]);
    expect(a[1]).not.toBe(b[1]);
  });

  it("gives different tests different values under one seed", async () => {
    const other = { "tests/u.test.md": files["tests/t.test.md"] };
    const t = await expand(files, "tests/t.test.md", { seed: "same" });
    const u = await expand(other, "tests/u.test.md", { seed: "same" });
    expect(t.expanded.data.email?.display).not.toBe(u.expanded.data.email?.display);
  });

  it("uses the configured email domain", async () => {
    const { expanded } = await expand(files, "tests/t.test.md", { emailDomain: "qa.acme.dev" });
    expect(expanded.data.email?.display).toMatch(/@qa\.acme\.dev$/);
  });

  it("accepts registered generators without parser changes", async () => {
    const generators = new GeneratorRegistry().register(
      "unique.slug",
      (rng) => `slug-${rng.token(4)}`,
    );
    const text = file("name: T", "1. Use {{unique.slug}}");
    expect(codes(parseTest(text, "tests/t.test.md").diagnostics)).toEqual(["VAR_MEMBER_UNKNOWN"]);
    const parsed = parseTest(text, "tests/t.test.md", { generators });
    expect(parsed.diagnostics).toEqual([]);
    const expanded = await expandTest(parsed.spec, {
      readFile: mapReader({}),
      seed: "x",
      generators,
    });
    expect(expanded.steps[0]?.display).toMatch(/^Use slug-[0-9a-z]{4}$/);
  });
});
