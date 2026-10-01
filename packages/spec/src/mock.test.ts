import { resolveConfig } from "@optestra/config";
import { describe, expect, it } from "vitest";
import { mapReader } from "./expand.js";
import { expandTest } from "./expand.js";
import { parseTest } from "./parse.js";
import { printTest } from "./print.js";

// Mock: steps (ENV-4): the phrasing, what lint says about a bad one, and the
// "not supported yet" message on Android.

const file = (steps: string) => `---\nname: T\nstart: /\n---\n\n${steps}\n`;

describe("Mock: steps", () => {
  it("reads a status, a body file, or both, and prints them back the same", () => {
    const text = file(
      [
        "1. Mock: GET /api/orders returns 500",
        "2. Mock: GET /api/orders/* returns files/orders.json",
        "3. Mock: POST https://127.0.0.1:4100/api/pay returns 402 files/declined.json",
        '4. Expect: the page shows "Orders"',
      ].join("\n"),
    );
    const { spec, diagnostics } = parseTest(text, "tests/t.test.md");
    expect(diagnostics).toEqual([]);
    const ops = spec.body.flatMap((item) =>
      item.type === "step" && item.kind === "exact" && item.exact.form === "op"
        ? [item.exact.op]
        : [],
    );
    expect(ops).toMatchObject([
      { op: "mock", method: "GET", url: { raw: "/api/orders" }, status: 500 },
      {
        op: "mock",
        method: "GET",
        url: { raw: "/api/orders/*" },
        status: 200,
        body: "files/orders.json",
      },
      { op: "mock", method: "POST", status: 402, body: "files/declined.json" },
    ]);
    expect(printTest(spec)).toBe(text);
    // `mock:` in any case, canonical `Mock:` when printed.
    expect(printTest(parseTest(file("1. mock: get /api/x returns 204"), "t").spec)).toContain(
      "1. Mock: GET /api/x returns 204",
    );
  });

  it("explains a Mock: line it can't read", () => {
    const codes = (line: string) =>
      parseTest(file(`1. ${line}`), "tests/t.test.md")
        .diagnostics.filter((d) => d.code === "MOCK_SYNTAX")
        .map((d) => [d.code, d.message]);
    expect(codes("Mock: FETCH /api returns 500")[0]).toEqual([
      "MOCK_SYNTAX",
      '"FETCH" is not an HTTP method.',
    ]);
    expect(codes("Mock: GET api/orders returns 500")[0]?.[1]).toContain(
      "must be a path starting with /",
    );
    expect(codes("Mock: GET /api/orders gives 500")[0]?.[1]).toContain('Expected "returns"');
    expect(codes("Mock: GET /api/orders returns")[0]?.[1]).toContain("Say what it returns");
    expect(codes("Mock: GET /api returns 999")[0]?.[1]).toContain("not an HTTP status");
    expect(codes("Mock: GET /api returns ../secrets.json")[0]?.[1]).toContain("inside the project");
  });

  it("is refused on Android, plainly", () => {
    const config = resolveConfig({
      project: { version: 1, project: { name: "A", target: "android" } },
    }).config;
    const { diagnostics } = parseTest(file("1. Mock: GET /api returns 500"), "tests/t.test.md", {
      config,
    });
    expect(diagnostics.map((d) => [d.code, d.severity])).toContainEqual([
      "MOCK_UNSUPPORTED",
      "error",
    ]);
    expect(diagnostics.find((d) => d.code === "MOCK_UNSUPPORTED")?.message).toContain(
      "not supported on Android yet",
    );
  });

  it("expands with its URL bound, and its text as written", async () => {
    const text = file("1. Mock: GET {{env.API}}/orders returns 500");
    const { spec } = parseTest(text, "tests/t.test.md");
    const expanded = await expandTest(spec, {
      readFile: mapReader({ "tests/t.test.md": text }),
      seed: "s",
      vars: { API: "https://api.example.test" },
    });
    const step = expanded.steps[0];
    expect(step?.text).toBe("Mock: GET {{env.API}}/orders returns 500");
    expect(
      step?.exact?.form === "op" && step.exact.op.op === "mock" && step.exact.op.url.display,
    ).toBe("https://api.example.test/orders");
  });
});
