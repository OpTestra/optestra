import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTest } from "./parse.js";
import { printTest, withoutSource } from "./print.js";
import { file } from "./spec.test-support.js";

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/tests/", import.meta.url));
const shopFiles = [
  ...readdirSync(SHOP)
    .filter((f) => f.endsWith(".test.md"))
    .map((f) => join(SHOP, f)),
  join(SHOP, "flows/login.test.md"),
];

const roundTrip = (text: string) => {
  const first = parseTest(text, "tests/t.test.md");
  const printed = printTest(first.spec);
  const second = parseTest(printed, "tests/t.test.md");
  return { first, printed, second };
};

describe("printTest", () => {
  it.each(shopFiles.map((f) => [f.slice(SHOP.length), f]))(
    "prints the canonical fixture %s byte for byte",
    (_name, path) => {
      const text = readFileSync(path, "utf8");
      expect(printTest(parseTest(text, "tests/x.test.md").spec)).toBe(text);
    },
  );

  const messy = [
    file(
      [
        "tags:   [ b,  a ]",
        "name:  'Messy but valid'",
        "timeout: 120s",
        "kind: test",
        "allowDestructive:",
        "  - delete",
        "heal: auto",
        "setup:",
        "  - request: post /api/seed",
        "    body:",
        "      user: { name: Ada, roles: [admin] }",
        "      count: 2",
        "  - sql: DELETE FROM carts",
        "environments:",
        "  staging:",
        "    timeout: 3600s",
        "  empty: {}",
        "owner: qa # unknown key, kept",
      ],
      [
        "",
        "",
        "<!-- a comment",
        "     over two lines -->",
        '1) click  "Go"',
        "   and wait",
        "",
        "",
        "",
        "2. expect:the page says 'hi'",
        "stray text",
        "3. SOFT: looks fine",
        '4. exact:  click   role=button[name="Save"]',
        '5. Exact: select Large in label="Size"',
        '6. use: flows/f.test.md {a: 1, b: "{{data.x}}"}',
        "7. Some code",
        "```ts",
        "  const a = 1;",
        "",
        "  ```nested``` fence",
        "```",
        "8. ```ts",
        "   x();",
        "   ```",
        'never: click "Delete"',
        "9. Exact: click button=Broken",
      ],
    ),
    "no frontmatter at all\n1. a step\n",
    file("name: Only name", ""),
  ];

  it.each(messy.map((text, i) => [i, text]))(
    "round-trips messy file %i to the same model",
    (_i, text) => {
      const { first, printed, second } = roundTrip(text);
      expect(withoutSource(second.spec)).toEqual(withoutSource(first.spec));
      // Printing is idempotent: the printed text is canonical.
      expect(printTest(second.spec)).toBe(printed);
      // Problems survive printing (printing adds an empty frontmatter when there was none).
      const problems = (list: typeof first.diagnostics) =>
        list
          .map((d) => d.code)
          .filter((c) => c !== "FRONTMATTER_MISSING" && c !== "REQUIRED_MISSING")
          .sort();
      expect(problems(second.diagnostics)).toEqual(problems(first.diagnostics));
    },
  );

  it("writes the canonical form", () => {
    const { printed } = roundTrip(messy[0] ?? "");
    expect(printed).toBe(`---
name: Messy but valid
tags: [b, a]
setup:
  - request: POST /api/seed
    body: { user: { name: Ada, roles: [ admin ] }, count: 2 }
  - sql: DELETE FROM carts
timeout: 2m
heal: auto
allowDestructive: [delete]
environments:
  staging:
    timeout: 1h
  empty: {}
owner: qa
---

<!-- a comment
     over two lines -->
1. click  "Go" and wait

2. Expect: the page says 'hi'
stray text
3. Soft: looks fine
4. Exact: click role=button[name="Save"]
5. Exact: select "Large" in label="Size"
6. Use: flows/f.test.md { a: "1", b: "{{data.x}}" }
7. Some code
   \`\`\`\`ts
     const a = 1;

     \`\`\`nested\`\`\` fence
   \`\`\`\`
8. \`\`\`ts
   x();
   \`\`\`
Never: click "Delete"
9. Exact: click button=Broken
`);
  });

  it("prints a spec built in code (no positions)", () => {
    const { spec } = parseTest(file("name: Draft"), "tests/draft.test.md");
    const built = withoutSource(spec);
    built.frontmatter.tags = ["new"];
    built.body.push({
      type: "step",
      kind: "expect",
      number: 2,
      text: { raw: "it works", segments: [{ kind: "text", text: "it works" }] },
    });
    expect(printTest(built)).toBe(
      '---\nname: Draft\ntags: [new]\n---\n\n1. Click "Go"\n2. Expect: it works\n',
    );
  });
});
