import { resolveConfig } from "@optestra/config";
import { describe, expect, it } from "vitest";
import { mapReader } from "../expand.js";
import { createLanguageService } from "./index.js";

const FLOW = `---
name: Log in
kind: flow
params:
  email: ada@example.com
  password:
---

1. Go to /login
2. Fill "Email" with {{params.email}}
3. Fill "Password" with {{params.password}}
`;

const TEST = `---
name: Checkout
kind: test
start: /pricing
data:
  email: "{{unique.email}}"
setup:
  - request: POST /api/seed
---

1. Use: flows/login.test.md { password: "{{secret.SHOP_PASSWORD}}" }
2. Fill "Email" with {{data.email}}
3. Exact: click role=button[name="Pay"]
4. Some code
   \`\`\`ts
   await page.fill("{{", "x");
   \`\`\`
5. Expect: it works
`;

const PLANTED = "planted-Secret-Value-9zQ";
const config = resolveConfig({
  project: {
    version: 1,
    project: { name: "Shop", target: "web" },
    environments: { local: { baseUrl: "http://localhost:3000", vars: { GREETING: "hi" } } },
    secrets: { SHOP_PASSWORD: { domains: ["localhost"] }, ADMIN_TOKEN: { domains: ["localhost"] } },
  },
}).config;
process.env.SHOP_PASSWORD = PLANTED;

const files = { "tests/flows/login.test.md": FLOW, "tests/checkout.test.md": TEST };
const service = createLanguageService({
  config,
  readFile: mapReader(files),
  listFiles: () => Object.keys(files),
  authProfiles: ["admin", "member"],
  isSecretSet: (name) => name === "SHOP_PASSWORD",
});
const PATH = "tests/checkout.test.md";

/** Text with the cursor at "|" removed, and the cursor position. */
function cursor(text: string) {
  const index = text.indexOf("|");
  const before = text.slice(0, index).split("\n");
  return {
    text: text.slice(0, index) + text.slice(index + 1),
    position: { line: before.length, column: (before[before.length - 1] ?? "").length + 1 },
  };
}
const complete = async (text: string) => {
  const c = cursor(text);
  return (await service.completions(c.text, PATH, c.position)).map((i) => i.label);
};
const withLine = (line: string) => TEST.replace("5. Expect: it works\n", `${line}\n`);

describe("completions", () => {
  it("offers namespaces after {{ and members after a dot", async () => {
    expect(await complete(withLine("5. Type {{|"))).toEqual([
      "data",
      "env",
      "secret",
      "unique",
      "faker",
      "inbox",
    ]);
    expect(await complete(withLine("5. Type {{ se|"))).toEqual(["secret"]);
    expect(await complete(withLine("5. Type {{inbox.|"))).toEqual(["code", "link", "subject"]);
    expect(await complete(withLine("5. Type {{secret.|"))).toEqual(
      ["SHOP_PASSWORD", "ADMIN_TOKEN"].sort(),
    );
    expect(await complete(withLine("5. Type {{data.|"))).toEqual(["email"]);
    expect(await complete(withLine("5. Type {{env.|"))).toEqual(["GREETING"]);
    expect(await complete(withLine("5. Type {{unique.e|"))).toEqual(["email"]);
    const [item] = await service.completions(
      ...(() => {
        const c = cursor(withLine("5. Type {{data.e|"));
        return [c.text, PATH, c.position] as const;
      })(),
    );
    expect(item).toMatchObject({
      insertText: "email}}",
      range: { start: { line: 18, column: 16 }, end: { line: 18, column: 17 } },
    });
  });

  it("offers params only in flows", async () => {
    const c = cursor(FLOW.replace("3. Fill", "3. {{params.|} Fill"));
    const labels = (await service.completions(c.text, "tests/flows/login.test.md", c.position)).map(
      (i) => i.label,
    );
    expect(labels).toEqual(["email", "password"]);
    expect(await complete(withLine("5. {{par|"))).toEqual([]);
  });

  it("gives nothing inside a fenced code block, even after {{", async () => {
    const lines = TEST.split("\n");
    const code = lines.findIndex((l) => l.includes('page.fill("{{'));
    expect(await service.completions(TEST, PATH, { line: code + 1, column: 22 })).toEqual([]);
  });

  it("offers prefixes, the next number, flows and exact syntax in the body", async () => {
    expect(await complete(withLine("5. |"))).toEqual([
      "Expect:",
      "Soft:",
      "Never:",
      "Use:",
      "Exact:",
    ]);
    expect(await complete(withLine("5. Ex|"))).toEqual(["Expect:", "Exact:"]);
    expect(await complete(withLine("|"))).toEqual(["5.", "Never:"]);
    expect(await complete(withLine("5. Use: |"))).toEqual(["flows/login.test.md"]);
    expect(await complete(withLine("5. Exact: |"))).toEqual([
      "goto",
      "click",
      "fill",
      "select",
      "press",
      "expect",
    ]);
    expect(await complete(withLine("5. Exact: click |"))).toContain('label="');
    expect(await complete(withLine("5. Exact: click role=b|"))).toEqual(["role=button"]);
    expect(await complete(withLine('5. Exact: fill label="Email" |'))).toEqual(["with"]);
    expect(await complete(withLine("5. Exact: expect |"))).toContain("url");
    expect(await complete(withLine("5. Exact: expect url |"))).toEqual(["contains", "is"]);
    expect(await complete(withLine('5. Exact: expect text="x" |'))).toContain("visible");
  });

  it("offers keys and values in the frontmatter", async () => {
    const keys = await complete(TEST.replace("kind: test\n", "|\n"));
    expect(keys).toContain("tags");
    expect(keys).toContain("kind");
    expect(keys).not.toContain("name");
    expect(await complete(TEST.replace("kind: test", "kind: |"))).toEqual(["test", "flow"]);
    expect(await complete(TEST.replace("kind: test", "heal: |"))).toEqual([
      "strict",
      "review",
      "auto",
    ]);
    expect(await complete(TEST.replace("kind: test", "auth: |"))).toEqual([
      "admin",
      "member",
      "none",
    ]);
    expect(await complete(TEST.replace("kind: test", "allowDestructive: [delete, p|"))).toEqual([
      "pay",
    ]);
    expect(await complete(TEST.replace("  - request: POST /api/seed", "  - |"))).toEqual([
      "request",
      "run",
      "sql",
    ]);
    expect(await complete(TEST.replace("  - request: POST /api/seed", "  - request: P|"))).toEqual([
      "POST",
      "PUT",
      "PATCH",
    ]);
    expect(await complete(TEST.replace("---\nname", "|---\nname"))).toEqual([]);
  });
});

describe("hover", () => {
  const hoverAt = async (needle: string, offset = 2) => {
    const lines = TEST.split("\n");
    const line = lines.findIndex((l) => l.includes(needle));
    return service.hover(TEST, PATH, {
      line: line + 1,
      column: (lines[line] ?? "").indexOf(needle) + 1 + offset,
    });
  };

  it("explains variables; a secret shows its name, domains and status, never its value", async () => {
    const secret = await hoverAt("{{secret.SHOP_PASSWORD}}");
    expect(secret?.contents).toContain("secret.SHOP_PASSWORD");
    expect(secret?.contents).toContain("localhost");
    expect(secret?.contents).toContain("Value: set.");
    expect(JSON.stringify(secret)).not.toContain(PLANTED);
    expect((await hoverAt("{{data.email}}"))?.contents).toContain("{{unique.email}}");
    expect((await hoverAt('"{{unique.email}}"', 4))?.contents).toContain("generated per run");
  });

  it("explains inbox values", async () => {
    const text = withLine('5. Fill "Verification code" with {{inbox.code}}');
    const lines = text.split("\n");
    const line = lines.findIndex((l) => l.includes("{{inbox.code}}"));
    const hover = await service.hover(text, PATH, {
      line: line + 1,
      column: (lines[line] ?? "").indexOf("{{inbox.code}}") + 4,
    });
    expect(hover?.contents).toContain("**inbox.code**");
    expect(hover?.contents).toContain("never the value");
  });

  it("documents frontmatter fields, flows, exact ops and findings", async () => {
    expect((await hoverAt("start: /pricing", 0))?.contents).toContain("**start**");
    const flow = await hoverAt("flows/login.test.md", 3);
    expect(flow?.contents).toContain("**Log in**");
    expect(flow?.contents).toContain("`email` = `ada@example.com`");
    expect(flow?.contents).toContain("`password` (required) → `{{secret.SHOP_PASSWORD}}`");
    expect((await hoverAt("click role=button", 0))?.contents).toContain("**click**");
    const finding = await hoverAt("it works");
    expect(finding?.contents).toContain("expect-not-observable");
  });

  it("never shows a planted secret value anywhere", async () => {
    const lines = TEST.split("\n");
    for (let line = 1; line <= lines.length; line++) {
      for (let column = 1; column <= (lines[line - 1] ?? "").length + 1; column += 3) {
        const h = await service.hover(TEST, PATH, { line, column });
        const c = await service.completions(TEST, PATH, { line, column });
        expect(JSON.stringify([h, c])).not.toContain(PLANTED);
      }
    }
  });
});

describe("actions, format, outline, definition", () => {
  it("returns a finding's fixes as code actions", async () => {
    const text = withLine('5. Fill "Password" with hunter2hunter2');
    const line = text.split("\n").findIndex((l) => l.includes("hunter2")) + 1;
    const actions = await service.codeActions(text, PATH, {
      start: { line, column: 1 },
      end: { line, column: 40 },
    });
    expect(actions.map((a) => [a.title, a.safe, a.diagnostic.rule])).toContainEqual([
      "Use {{secret.PASSWORD}} instead",
      false,
      "literal-credential",
    ]);
  });

  it("formats to the canonical text and does nothing when already canonical", () => {
    expect(service.format(TEST, PATH)).toEqual([
      {
        range: { start: { line: 1, column: 1 }, end: { line: TEST.split("\n").length, column: 1 } },
        newText: TEST.replace("kind: test\n", ""),
      },
    ]);
    const canonical = TEST.replace("kind: test\n", "");
    expect(service.format(canonical, PATH)).toEqual([]);
  });

  it("outlines the steps", () => {
    expect(service.outline(TEST, PATH).map((o) => [o.number, o.kind, o.label])).toEqual([
      [1, "flow", "Use: flows/login.test.md"],
      [2, "action", 'Fill "Email" with {{data.email}}'],
      [3, "exact", 'Exact: click role=button[name="Pay"]'],
      [4, "exact", "Some code"],
      [5, "expect", "Expect: it works"],
    ]);
  });

  it("goes to the flow of a Use: line", async () => {
    expect(await service.definition(TEST, PATH, { line: 11, column: 12 })).toEqual({
      path: "tests/flows/login.test.md",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    });
    expect(await service.definition(TEST, PATH, { line: 12, column: 5 })).toBeNull();
  });

  it("diagnostics are the checkTest findings", async () => {
    const findings = await service.diagnostics(TEST, PATH);
    expect(findings.map((f) => f.rule ?? f.code)).toEqual([
      "no-expectations",
      "destructive-undeclared",
      "expect-not-observable",
    ]);
  });
});

describe("performance", () => {
  it("answers every call in under 20 ms on a 200-step file", async () => {
    const body = Array.from({ length: 200 }, (_, i) =>
      i % 4 === 3
        ? `${i + 1}. Expect: the heading is "Step ${i}"`
        : `${i + 1}. Fill "Field ${i}" with {{data.email}}`,
    );
    const big = `---\nname: Big\nstart: /x\ndata:\n  email: "{{unique.email}}"\n---\n\n${body.join("\n")}\n`;
    const position = { line: 100, column: 30 };
    const range = { start: position, end: position };
    const calls: [string, () => unknown][] = [
      ["diagnostics", () => service.diagnostics(big, "tests/big.test.md")],
      ["completions", () => service.completions(big, "tests/big.test.md", position)],
      ["hover", () => service.hover(big, "tests/big.test.md", position)],
      ["codeActions", () => service.codeActions(big, "tests/big.test.md", range)],
      ["format", () => service.format(big, "tests/big.test.md")],
      ["outline", () => service.outline(big, "tests/big.test.md")],
      ["definition", () => service.definition(big, "tests/big.test.md", position)],
    ];
    const timings: Record<string, number> = {};
    for (const [name, call] of calls) {
      await call(); // warm up
      // The median of several calls, so one garbage-collection pause on a busy
      // machine doesn't decide the result.
      const samples: number[] = [];
      for (let i = 0; i < 15; i++) {
        const start = performance.now();
        await call();
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      timings[name] = samples[Math.floor(samples.length / 2)] ?? 0;
    }
    console.log("language service ms/call (200 steps):", JSON.stringify(timings));
    // The target is 20 ms; shared CI machines (Windows especially) get headroom.
    const limit = process.env.CI ? 60 : 20;
    for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(limit);
  });
});
