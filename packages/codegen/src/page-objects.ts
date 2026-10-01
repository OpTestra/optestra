import { brand } from "@optestra/brand";
import type { Locator } from "@optestra/recording";
import { withHeader } from "./header.js";
import { locatorExpr } from "./locators.js";
import { type Expr, printModule, raw, type Stmt, stmt } from "./print/js.js";
import type { GeneratedFile } from "./spec.js";
import { camel, uniqueName } from "./values.js";

// Page objects (EXP-4), for `export --page-objects`. Shared by every spec of
// one export:
// - the locators of each page (by the route the recording saw) become getters
//   of a class in `pages/<page>.page.ts`, so a renamed button is fixed once;
// - each `Use:` flow (and an `auth:` profile's login) becomes an async helper in
//   `flows/<flow>.flow.ts`, called by every test that uses it. A flow whose code
//   comes out differently in two tests (other recordings, a secret given for a
//   param) gets one helper per variant.
// Off by default: without it the specs are self-contained, as before.

export const PAGES_DIR = "pages";
export const FLOWS_DIR = "flows";

interface Getter {
  name: string;
  expr: Expr;
  describe: string;
}

interface PageClass {
  className: string;
  module: string;
  route: string;
  getters: Map<string, Getter>;
  names: Set<string>;
}

interface FlowVariant {
  name: string;
  code: string;
  imports: Map<string, Set<string>>;
  title: string;
  tests: Set<string>;
}

/** A helper's body and what it needs, as the spec writer produced it. */
export interface FlowHelper {
  /** Project-relative flow file. */
  flowPath: string;
  /** Base of the helper's name, e.g. "Log in". */
  name: string;
  /** Shown in the helper's doc comment. */
  title: string;
  /** `{ page, secrets }: …`, `params: { … }`: the helper's parameters. */
  parameters: string[];
  body: Stmt[];
  /** Module (relative to the specs folder, no extension) → names it imports. */
  imports: Map<string, Set<string>>;
  /** The test using it (counted in the doc comment). */
  test: string;
}

const MAX_WORDS = 5;

function words(text: string): string[] {
  return text
    .replace(/\{\{[^}]*\}\}/g, " ")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS);
}

const pascal = (parts: string[]) => {
  const name = camel(parts);
  return name.replace(/^_/, "").replace(/^./, (c) => c.toUpperCase());
};

/** `/settings` → Settings, `/orders/{{data.id}}` → OrdersItem, `/` → Home. */
function pageBase(route: string | undefined): string {
  if (route === undefined) return "App";
  const path = route.replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0] ?? "";
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => (/\{\{/.test(segment) || /^\d+$/.test(segment) ? "item" : segment));
  return segments.length === 0 ? "Home" : pascal(segments.flatMap(words)) || "Page";
}

/** The page a route belongs to: its query and the values in it don't matter. */
function routeKey(route: string | undefined): string {
  if (route === undefined) return "";
  const path = route.replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0] ?? "";
  return path.replace(/\{\{[^}]*\}\}/g, ":value").replace(/\/+$/, "") || "/";
}

function getterBase(target: Locator): string {
  switch (target.kind) {
    case "role": {
      const name = target.name === undefined ? [] : words(target.name);
      const level = "level" in target && target.level !== undefined ? [`${target.level}`] : [];
      return camel([...name, target.role, ...level]);
    }
    case "label":
    case "placeholder":
      return camel([...words(target.text), "field"]);
    case "alt":
      return camel([...words(target.text), "image"]);
    case "title":
    case "text":
      return camel([...words(target.text), target.kind]);
    case "testId":
      return camel(words(target.value));
    case "css":
      return "element";
  }
}

function describeLocator(target: Locator): string {
  switch (target.kind) {
    case "role":
      return target.name === undefined ? `the ${target.role}` : `${target.role} "${target.name}"`;
    case "testId":
      return `test id "${target.value}"`;
    case "css":
      return `css ${target.selector}`;
    default:
      return `${target.kind} "${target.text}"`;
  }
}

/** One line of a doc comment: no comment terminator inside. */
const docText = (text: string) => text.replaceAll("*/", "*\\/").replace(/\s+/g, " ");

export class PageObjects {
  readonly #pages = new Map<string, PageClass>();
  readonly #classNames = new Set<string>();
  readonly #modules = new Set<string>();
  readonly #flows = new Map<string, { module: string; variants: Map<string, FlowVariant> }>();
  readonly #helperNames = new Set<string>();

  /** The page class for a route, and the getter for a locator on it. */
  locator(
    route: string | undefined,
    target: Locator,
    container?: Locator,
  ): { className: string; module: string; getter: string } {
    const key = routeKey(route);
    let page = this.#pages.get(key);
    if (!page) {
      const base = pageBase(route);
      const className = uniqueName(`${base}Page`, this.#classNames);
      const file = base
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/^-+/, "");
      const module = uniqueName(`${PAGES_DIR}/${file}.page`, this.#modules);
      page = {
        className,
        module,
        route: key || "(no page)",
        getters: new Map(),
        names: new Set(["page", "constructor"]),
      };
      this.#pages.set(key, page);
    }
    const expr = locatorExpr(target, container, raw("this.page"));
    const exprKey = printModule([stmt(expr)]);
    let getter = page.getters.get(exprKey);
    if (!getter) {
      getter = {
        name: uniqueName(getterBase(target), page.names),
        expr,
        describe: container
          ? `${describeLocator(target)} in ${describeLocator(container)}`
          : describeLocator(target),
      };
      page.getters.set(exprKey, getter);
    }
    return { className: page.className, module: page.module, getter: getter.name };
  }

  /** The helper for a flow's code: the same code in two tests is one helper. */
  flow(helper: FlowHelper): { name: string; module: string } {
    let flow = this.#flows.get(helper.flowPath);
    if (!flow) {
      const file =
        helper.flowPath
          .split("/")
          .pop()
          ?.replace(/\.test\.md$|\.md$/, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "flow";
      flow = {
        module: uniqueName(`${FLOWS_DIR}/${file}.flow`, this.#modules),
        variants: new Map(),
      };
      this.#flows.set(helper.flowPath, flow);
    }
    const printed = printModule([
      stmt({ t: "arrow", async: true, params: null, body: helper.body }),
    ]);
    const flat = `(${helper.parameters.join(", ")})`;
    const key = `${flat}\n${printed}`;
    let variant = flow.variants.get(key);
    if (!variant) {
      const name = uniqueName(camel(words(helper.name)) || "flow", this.#helperNames);
      // `async () => {` … `};` becomes the function's own head and end.
      const body = printed.replace(/^async \(\) => \{/, "").replace(/\};\n$/, "}");
      const head = `export async function ${name}`;
      const signature =
        `${head}${flat}: Promise<void> {`.length <= 100
          ? flat
          : `(\n${helper.parameters.map((p) => `  ${p},`).join("\n")}\n)`;
      variant = {
        name,
        code: `${head}${signature}: Promise<void> {${body}`,
        imports: helper.imports,
        title: helper.title,
        tests: new Set(),
      };
      flow.variants.set(key, variant);
    }
    variant.tests.add(helper.test);
    return { name: variant.name, module: flow.module };
  }

  /** The page and flow modules, after every spec was written. */
  files(): GeneratedFile[] {
    const out: GeneratedFile[] = [];
    for (const page of this.#pages.values()) {
      const getters = [...page.getters.values()].map((getter) => {
        const printed = printModule([stmt(getter.expr)], 100 - 4 - "return ".length)
          .trimEnd()
          .split("\n");
        const body = printed.map((line, i) => `    ${i === 0 ? "return " : ""}${line}`).join("\n");
        return `  /** ${docText(getter.describe)} */\n  get ${getter.name}() {\n${body}\n  }`;
      });
      const code = [
        'import type { Page } from "@playwright/test";',
        "",
        `/** ${docText(page.route)}: the elements the recorded tests use there. */`,
        `export class ${page.className} {`,
        "  constructor(readonly page: Page) {}",
        ...getters.flatMap((getter) => ["", getter]),
        "}",
        "",
      ].join("\n");
      out.push({
        name: `${page.module}.ts`,
        content: withHeader(code, { from: `the recorded tests (page objects for ${page.route})` }),
      });
    }
    for (const [flowPath, flow] of this.#flows) {
      const imports = new Map<string, Set<string>>();
      for (const variant of flow.variants.values())
        for (const [module, names] of variant.imports) {
          const set = imports.get(module) ?? new Set();
          for (const name of names) set.add(name);
          imports.set(module, set);
        }
      const importLines = [...imports.entries()]
        .sort(([a], [b]) => importRank(a) - importRank(b) || (a < b ? -1 : a > b ? 1 : 0))
        .map(([module, names]) => importLine([...names], module, flow.module));
      const functions = [...flow.variants.values()].map((variant) => {
        const used = [...variant.tests].sort();
        const doc = `/** ${docText(variant.title)}. Used by ${used.length === 1 ? used[0] : `${used.length} tests`}. */`;
        return `${doc}\n${variant.code}`;
      });
      const code = [...importLines, "", ...functions.flatMap((f, i) => (i ? ["", f] : [f])), ""];
      out.push({
        name: `${flow.module}.ts`,
        content: withHeader(code.join("\n"), { from: `${flowPath} (page objects)` }),
      });
    }
    return out;
  }
}

/** Packages first, then the fixtures, then our modules. */
function importRank(module: string): number {
  if (!module.startsWith(".") && module.includes("@")) return 0;
  if (module === FIXTURES_MODULE_NAME) return 1;
  return 2;
}

const FIXTURES_MODULE_NAME = `${brand.cliName}.fixtures`;

/** `import { a, type B } from "<relative module>";` from a module in the specs folder. */
export function importLine(names: string[], module: string, from: string): string {
  const sorted = [...new Set(names)].sort((a, b) =>
    a.replace(/^type /, "").localeCompare(b.replace(/^type /, ""), "en"),
  );
  const target = module.startsWith("@") ? module : relativeModule(from, module);
  // Only types: `import type { A, B }`.
  const typeOnly = sorted.every((name) => name.startsWith("type "));
  const shown = typeOnly ? sorted.map((name) => name.slice(5)) : sorted;
  const keyword = typeOnly ? "import type" : "import";
  const flat = `${keyword} { ${shown.join(", ")} } from "${target}";`;
  if (flat.length <= 100) return flat;
  return `${keyword} {\n${shown.map((name) => `  ${name},`).join("\n")}\n} from "${target}";`;
}

/** `pages/settings.page` seen from `flows/login.flow` → `../pages/settings.page`. */
export function relativeModule(from: string, to: string): string {
  const depth = from.split("/").length - 1;
  return depth === 0 ? `./${to}` : `${"../".repeat(depth)}${to}`;
}
