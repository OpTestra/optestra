import {
  breakParent,
  conditionalGroup,
  type Doc,
  group,
  hardline,
  ifBreak,
  indent,
  join,
  line,
  printDoc,
  softline,
  willBreak,
} from "./doc.js";

// A tiny TypeScript AST for the code the generator writes, printed in the
// style Biome's formatter uses by default (double quotes unless single quotes
// need fewer escapes, semicolons, trailing commas, 2 spaces, 100 columns), so
// generated files pass `biome format` unchanged. Member chains and call
// arguments follow Prettier's layout rules, which Biome implements.

export type Expr =
  | { t: "id"; name: string }
  | { t: "str"; value: string }
  | { t: "raw"; text: string }
  | { t: "tpl"; parts: Array<string | Expr> }
  | { t: "member"; object: Expr; name: string; optional?: boolean }
  | { t: "call"; callee: Expr; args: Expr[] }
  | { t: "new"; callee: Expr; args: Expr[] }
  | { t: "obj"; props: Array<[key: string, value: Expr]> }
  | { t: "arr"; items: Expr[] }
  | { t: "arrow"; async: boolean; params: string[] | null; body: Stmt[] }
  | { t: "await"; expr: Expr };

export type Stmt =
  | { t: "expr"; expr: Expr }
  | { t: "const"; name: string; init: Expr }
  | { t: "comment"; text: string }
  | { t: "blank" }
  | { t: "verbatim"; code: string };

// ── builders ─────────────────────────────────────────────────────────────────

export const id = (name: string): Expr => ({ t: "id", name });
export const str = (value: string): Expr => ({ t: "str", value });
export const raw = (text: string): Expr => ({ t: "raw", text });
export const num = (value: number): Expr => ({ t: "raw", text: formatNumber(value) });
export const tpl = (parts: Array<string | Expr>): Expr => ({ t: "tpl", parts });
export const obj = (props: Array<[string, Expr]>): Expr => ({ t: "obj", props });
export const arr = (items: Expr[]): Expr => ({ t: "arr", items });
export const awaited = (expr: Expr): Expr => ({ t: "await", expr });
export const arrow = (params: string[] | null, body: Stmt[], async = true): Expr => ({
  t: "arrow",
  async,
  params,
  body,
});
export const newExpr = (callee: Expr, args: Expr[]): Expr => ({ t: "new", callee, args });

/** `a.b.c` from a dotted path. */
export function path(dotted: string): Expr {
  const [head, ...rest] = dotted.split(".");
  return rest.reduce<Expr>((object, name) => member(object, name), id(head as string));
}

export const member = (object: Expr, name: string): Expr => ({ t: "member", object, name });
export const call = (callee: Expr | string, ...args: Expr[]): Expr => ({
  t: "call",
  callee: typeof callee === "string" ? path(callee) : callee,
  args,
});
/** `object.name(...args)` */
export const method = (object: Expr, name: string, ...args: Expr[]): Expr =>
  call(member(object, name), ...args);

export const stmt = (expr: Expr): Stmt => ({ t: "expr", expr });
export const constStmt = (name: string, init: Expr): Stmt => ({ t: "const", name, init });
export const comment = (text: string): Stmt => ({ t: "comment", text });
export const blank: Stmt = { t: "blank" };

/** Numbers as Biome leaves them; large ones get `_` separators for readability. */
export function formatNumber(value: number): string {
  if (!Number.isInteger(value) || Math.abs(value) < 10_000) return String(value);
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}

// ── strings ──────────────────────────────────────────────────────────────────

/** A string literal: double quotes unless the value has more double than single quotes. */
export function quote(value: string): string {
  const doubles = (value.match(/"/g) ?? []).length;
  const singles = (value.match(/'/g) ?? []).length;
  const json = JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  if (doubles <= singles) return json;
  const inner = json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'");
  return `'${inner}'`;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export const isIdentifier = (name: string): boolean => IDENTIFIER.test(name);

function propertyKey(key: string, allSimple: boolean): string {
  return allSimple ? key : isIdentifier(key) ? key : quote(key);
}

/** Text of a template literal chunk: backticks, `${` and backslashes escaped. */
export function templateChunk(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

// ── expressions ──────────────────────────────────────────────────────────────

const TEST_CALLS = new Set([
  "it",
  "it.only",
  "it.skip",
  "describe",
  "describe.only",
  "describe.skip",
  "test",
  "test.only",
  "test.skip",
  "test.step",
  "test.describe",
  "test.describe.only",
  "test.describe.parallel",
  "test.describe.parallel.only",
  "test.describe.serial",
  "test.describe.serial.only",
  "skip",
  "xit",
  "xdescribe",
  "xtest",
  "fit",
  "fdescribe",
  "ftest",
]);

function dottedName(expr: Expr): string | undefined {
  if (expr.t === "id") return expr.name;
  if (expr.t === "member") {
    const object = dottedName(expr.object);
    return object === undefined ? undefined : `${object}.${expr.name}`;
  }
  return undefined;
}

/** `test("title", fn)` and Playwright's `test("title", { tag }, fn)`: never broken apart. */
function isTestCall(expr: Expr & { t: "call" }): boolean {
  const name = dottedName(expr.callee);
  if (!name || !TEST_CALLS.has(name)) return false;
  const [title, ...rest] = expr.args;
  if (title?.t !== "str" && title?.t !== "tpl") return false;
  if (rest.length === 1) return rest[0]?.t === "arrow";
  return rest.length === 2 && rest[0]?.t === "obj" && rest[1]?.t === "arrow";
}

function isSimpleArgument(expr: Expr, depth = 0): boolean {
  switch (expr.t) {
    case "id":
    case "str":
    case "raw":
      return true;
    case "tpl":
      return expr.parts.every((part) => typeof part === "string" || isSimpleArgument(part, depth));
    case "obj":
      return expr.props.every(([, value]) => isSimpleArgument(value, depth));
    case "arr":
      return expr.items.every((item) => isSimpleArgument(item, depth));
    case "member":
      return isSimpleArgument(expr.object, depth);
    case "call":
    case "new":
      return (
        depth < 2 &&
        (expr.callee.t === "id" || expr.callee.t === "member") &&
        isSimpleArgument(expr.callee, depth) &&
        expr.args.every((arg) => isSimpleArgument(arg, depth + 1))
      );
    case "await":
    case "arrow":
      return false;
  }
}

function printArrow(expr: Expr & { t: "arrow" }): Doc {
  const params =
    expr.params === null
      ? "()"
      : expr.params.length === 0
        ? "()"
        : group(["({", indent([line, join([",", line], expr.params)]), ifBreak(","), line, "})"]);
  const head = [expr.async ? "async " : "", params, " => "];
  if (expr.body.length === 0) return [...head, "{}"];
  return [...head, "{", indent([hardline, printStatements(expr.body)]), hardline, "}"];
}

function shouldGroupLast(args: Expr[]): boolean {
  const last = args.at(-1);
  const penultimate = args.at(-2);
  if (!last) return false;
  const groupable = (last.t === "obj" && last.props.length > 0) || last.t === "arrow";
  return groupable && penultimate?.t !== last.t;
}

function printArguments(args: Expr[]): Doc {
  if (args.length === 0) return "()";
  const printed = args.map(printExpr);
  const allBrokenOut = () =>
    group(["(", indent([line, join([",", line], printed)]), ifBreak(","), softline, ")"], {
      shouldBreak: true,
    });
  if (shouldGroupLast(args)) {
    const head = printed.slice(0, -1);
    const last = printed.at(-1) as Doc;
    if (head.some(willBreak)) return allBrokenOut();
    return [
      printed.some(willBreak) ? breakParent : "",
      conditionalGroup([
        ["(", join(", ", [...head, last]), ")"],
        ["(", join(", ", [...head, group(last, { shouldBreak: true })]), ")"],
        allBrokenOut(),
      ]),
    ];
  }
  return group(["(", indent([softline, join([",", line], printed)]), ifBreak(","), softline, ")"]);
}

interface ChainNode {
  expr: Expr;
  doc: Doc;
}

/** Flattens `a.b(x).c(y)` into [a, .b, (x), .c, (y)]. */
function flatten(expr: Expr, out: ChainNode[]): void {
  if (expr.t === "call") {
    flatten(expr.callee, out);
    out.push({ expr, doc: printArguments(expr.args) });
    return;
  }
  if (expr.t === "member") {
    flatten(expr.object, out);
    out.push({ expr, doc: `.${expr.name}` });
    return;
  }
  out.push({ expr, doc: printExpr(expr) });
}

const isFactory = (name: string) => /^[A-Z]|^[$_]+$/.test(name);

function printMemberChain(expr: Expr & { t: "call" }): Doc {
  const nodes: ChainNode[] = [];
  flatten(expr, nodes);
  // The first group: the head, the calls right after it, and (for a plain
  // head) member accesses followed by more member accesses (`page.request.post`).
  const first: ChainNode[] = [nodes[0] as ChainNode];
  let i = 1;
  for (; i < nodes.length && (nodes[i] as ChainNode).expr.t === "call"; i++) {
    first.push(nodes[i] as ChainNode);
  }
  if ((nodes[0] as ChainNode).expr.t !== "call") {
    for (
      ;
      i + 1 < nodes.length &&
      (nodes[i] as ChainNode).expr.t === "member" &&
      (nodes[i + 1] as ChainNode).expr.t === "member";
      i++
    ) {
      first.push(nodes[i] as ChainNode);
    }
  }
  const groups: ChainNode[][] = [];
  let current: ChainNode[] = [];
  let seenCall = false;
  for (; i < nodes.length; i++) {
    const node = nodes[i] as ChainNode;
    if (seenCall && node.expr.t === "member") {
      groups.push(current);
      current = [];
      seenCall = false;
    }
    if (node.expr.t === "call") seenCall = true;
    current.push(node);
  }
  if (current.length > 0) groups.push(current);

  const printGroup = (group: ChainNode[]): Doc => group.map((node) => node.doc);
  const head = nodes[0] as ChainNode;
  // `groups` counts the first group too, as in Prettier.
  const all = [first, ...groups];
  const shouldMerge =
    all.length >= 2 &&
    groups[0]?.length !== 0 &&
    first.length === 1 &&
    head.expr.t === "id" &&
    (head.expr.name === "this" || isFactory(head.expr.name));
  const printed = all.map(printGroup);
  const oneLine: Doc = printed;
  const cutoff = shouldMerge ? 3 : 2;
  if (all.length <= cutoff && !printed.slice(cutoff).some(willBreak)) {
    return group(oneLine);
  }
  const indented = (list: ChainNode[][]): Doc =>
    list.length === 0 ? "" : indent(group([hardline, join(hardline, list.map(printGroup))]));
  const expanded: Doc = [
    printGroup(first),
    shouldMerge ? printGroup(groups[0] as ChainNode[]) : "",
    indented(groups.slice(shouldMerge ? 1 : 0)),
  ];
  const calls = nodes.filter((node) => node.expr.t === "call").map((node) => node.expr);
  const complexArguments = calls.some(
    (call) => call.t === "call" && !call.args.every((arg) => isSimpleArgument(arg)),
  );
  if ((calls.length > 2 && complexArguments) || printed.slice(0, -1).some(willBreak)) {
    return group(expanded);
  }
  return [willBreak(oneLine) ? breakParent : "", conditionalGroup([oneLine, expanded])];
}

export function printExpr(expr: Expr): Doc {
  switch (expr.t) {
    case "id":
      return expr.name;
    case "str":
      return quote(expr.value);
    case "raw":
      return expr.text;
    case "tpl":
      return [
        "`",
        ...expr.parts.map((part) =>
          typeof part === "string" ? templateChunk(part) : ["${", printDoc(printExpr(part)), "}"],
        ),
        "`",
      ];
    case "member":
      return [printExpr(expr.object), `.${expr.name}`];
    case "await":
      return ["await ", printExpr(expr.expr)];
    case "new":
      return ["new ", printExpr(expr.callee), printArguments(expr.args)];
    case "arrow":
      return printArrow(expr);
    case "obj": {
      if (expr.props.length === 0) return "{}";
      const simple = expr.props.every(([key]) => isIdentifier(key));
      const props = expr.props.map(([key, value]) => {
        const name = propertyKey(key, simple);
        return value.t === "id" && value.name === key && simple
          ? name
          : [name, ": ", printExpr(value)];
      });
      return group(["{", indent([line, join([",", line], props)]), ifBreak(","), line, "}"]);
    }
    case "arr": {
      if (expr.items.length === 0) return "[]";
      const shouldBreak =
        expr.items.length > 1 &&
        expr.items.every(
          (item) =>
            (item.t === "obj" && item.props.length > 1) ||
            (item.t === "arr" && item.items.length > 1),
        );
      return group(
        [
          "[",
          indent([softline, join([",", line], expr.items.map(printExpr))]),
          ifBreak(","),
          softline,
          "]",
        ],
        { shouldBreak },
      );
    }
    case "call": {
      if (isTestCall(expr)) {
        return [printExpr(expr.callee), "(", join(", ", expr.args.map(printExpr)), ")"];
      }
      if (expr.callee.t === "member") return printMemberChain(expr);
      return [printExpr(expr.callee), printArguments(expr.args)];
    }
  }
}

// ── statements ───────────────────────────────────────────────────────────────

function printStatement(statement: Stmt): Doc {
  switch (statement.t) {
    case "expr":
      return [printExpr(statement.expr), ";"];
    case "const":
      return ["const ", statement.name, " = ", printExpr(statement.init), ";"];
    case "comment":
      return `// ${statement.text}`.trimEnd();
    case "blank":
      return "";
    case "verbatim":
      return join(hardline, statement.code.split("\n"));
  }
}

export function printStatements(statements: readonly Stmt[]): Doc {
  const out: Doc[] = [];
  statements.forEach((statement, index) => {
    if (statement.t === "blank") {
      // One blank line at most, never at the start or end of a block.
      const previous = statements[index - 1];
      if (index === 0 || index === statements.length - 1 || previous?.t === "blank") return;
      out.push("");
      return;
    }
    out.push(printStatement(statement));
  });
  return join(hardline, out);
}

/** Prints a whole module: statements separated by line breaks, one trailing newline. */
export function printModule(statements: readonly Stmt[], width = 100): string {
  return `${printDoc(printStatements(statements), width).replace(/\n+$/, "")}\n`;
}
