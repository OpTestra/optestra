import type { ExactOp, Locator, Template } from "./model.js";
import { parseTemplate } from "./template.js";
import { type Reporter, SourceMap } from "./text.js";

/*
 * `Exact: <op>` grammar (AUT-3):
 *
 *   goto <url>
 *   click <locator>
 *   fill <locator> with <value>
 *   select <option> in <locator>
 *   press <key>
 *   expect url contains|is <value>
 *   expect <locator> text|contains "<value>"
 *   expect <locator> visible|hidden|enabled|disabled
 *   expect <locator> count <n>
 *
 * <locator>: role=button[name="Save"]  role=heading  label="Email"  testid=save
 *            text="Save"  placeholder="Search"  css=.x  (bare values stop at a space)
 * <value>, <option>, <url>: "quoted" (\" and \\ escapes) or the rest of the text.
 */

export const EXACT_OPS = [
  "goto",
  "click",
  "fill",
  "select",
  "press",
  "expect url",
  "expect text",
  "expect state",
  "expect count",
] as const;

const LOCATOR_KINDS = ["role", "label", "testid", "text", "placeholder", "css"] as const;
const STATES = ["visible", "hidden", "enabled", "disabled"] as const;

class SyntaxProblem {
  constructor(
    readonly offset: number,
    readonly end: number,
    readonly message: string,
    readonly fix: string,
  ) {}
}

const EXAMPLES =
  'e.g. Exact: click role=button[name="Save"], Exact: fill label="Email" with "ada@example.com", Exact: expect url contains /dashboard';

class Cursor {
  pos = 0;
  constructor(
    readonly text: string,
    readonly map: SourceMap | undefined,
    readonly report: Reporter | undefined,
  ) {}

  skipSpace() {
    while (this.text[this.pos] === " " || this.text[this.pos] === "\t") this.pos++;
  }

  atEnd() {
    this.skipSpace();
    return this.pos >= this.text.length;
  }

  fail(message: string, fix = `Use the exact-step syntax, ${EXAMPLES}.`, end?: number): never {
    throw new SyntaxProblem(this.pos, end ?? this.text.length, message, fix);
  }

  /** Fails pointing at text[start, end). */
  failAt(start: number, end: number, message: string, fix?: string): never {
    this.pos = start;
    this.fail(message, fix, end);
  }

  /** A bare word (letters, digits, - _ + .). */
  word(): string {
    this.skipSpace();
    const match = /^[^\s"[\]=]+/.exec(this.text.slice(this.pos));
    if (!match)
      this.fail(`Expected a word here, found "${this.text.slice(this.pos) || "nothing"}".`);
    this.pos += match[0].length;
    return match[0];
  }

  peekWord(): string {
    const save = this.pos;
    this.skipSpace();
    const match = /^[^\s"[\]=]+/.exec(this.text.slice(this.pos));
    this.pos = save;
    return match?.[0] ?? "";
  }

  keyword(...options: string[]): string {
    const start = this.pos;
    const found = this.atEnd() ? "" : this.word();
    if (!options.includes(found)) {
      this.pos = start;
      this.skipSpace();
      const shown = found || "nothing";
      this.fail(
        `Expected ${options.map((o) => `"${o}"`).join(" or ")}, found "${shown}".`,
        undefined,
        this.pos + (found.length || 0),
      );
    }
    return found;
  }

  quoted(): string {
    this.skipSpace();
    if (this.text[this.pos] !== '"') this.fail('Expected a "quoted" value here.');
    const start = this.pos;
    let out = "";
    this.pos++;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === "\\" && (this.text[this.pos + 1] === '"' || this.text[this.pos + 1] === "\\")) {
        out += this.text[this.pos + 1];
        this.pos += 2;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        return out;
      }
      out += ch;
      this.pos++;
    }
    this.pos = start;
    this.fail("This quoted value is never closed.", 'Add the closing " quote.');
  }

  /** A value: quoted, or the rest of the text (or up to `stop`). Returns the template. */
  value(what: string, stop?: RegExp): Template {
    this.skipSpace();
    if (this.pos >= this.text.length) this.fail(`Expected ${what} here.`);
    const start = this.pos;
    if (this.text[this.pos] === '"') {
      const raw = this.quoted();
      return parseTemplate(raw, this.shift(start + 1), this.report);
    }
    const rest = this.text.slice(this.pos);
    const match = stop ? stop.exec(rest) : null;
    const raw = (match ? rest.slice(0, match.index) : rest).trimEnd();
    this.pos += raw.length;
    return parseTemplate(raw, this.shift(start), this.report);
  }

  /** Map for a value starting at `offset`. Exact ops are one line, so a fixed origin is exact. */
  shift(offset: number): SourceMap | undefined {
    if (!this.map) return undefined;
    const origin = this.map.at(offset);
    return SourceMap.at(origin.line, origin.column);
  }

  locator(): Locator {
    this.skipSpace();
    const start = this.pos;
    const match = /^([a-z]+)=/.exec(this.text.slice(this.pos));
    const kind = match?.[1];
    if (!match || !kind || !(LOCATOR_KINDS as readonly string[]).includes(kind)) {
      this.fail(
        `Expected a locator here, found "${this.text.slice(this.pos) || "nothing"}".`,
        `Use role=button[name="Save"], label="Email", testid=save, text="Save", placeholder="Search" or css=.selector.`,
        this.pos + (/^\S*/.exec(this.text.slice(this.pos))?.[0].length ?? 0),
      );
    }
    this.pos += match[0].length;
    if (kind === "role") {
      const role = /^[a-z]+/.exec(this.text.slice(this.pos))?.[0];
      if (!role) this.fail('Expected an ARIA role after "role=", e.g. role=button.');
      this.pos += role.length;
      if (this.text[this.pos] !== "[") return { by: "role", role };
      this.pos++;
      if (!this.text.startsWith("name=", this.pos)) {
        this.fail('Expected name="…" inside the brackets, e.g. role=button[name="Save"].');
      }
      this.pos += "name=".length;
      const name = this.quoted();
      if (this.text[this.pos] !== "]") this.fail('Expected "]" to close the role locator.');
      this.pos++;
      return { by: "role", role, name };
    }
    let value: string;
    if (this.text[this.pos] === '"') value = this.quoted();
    else {
      value = /^\S+/.exec(this.text.slice(this.pos))?.[0] ?? "";
      this.pos += value.length;
    }
    if (value === "") {
      this.pos = start;
      this.fail(`Locator "${kind}=" needs a value, e.g. ${kind}="Save".`);
    }
    return { by: kind as Exclude<Locator["by"], "role">, value };
  }
}

function parseOp(c: Cursor): ExactOp {
  const verb = c.keyword("goto", "click", "fill", "select", "press", "expect");
  switch (verb) {
    case "goto":
      return { op: "goto", url: c.value("a URL or path") };
    case "click":
      return { op: "click", target: c.locator() };
    case "fill": {
      const target = c.locator();
      c.keyword("with");
      return { op: "fill", target, value: c.value("the value to type") };
    }
    case "select": {
      c.skipSpace();
      const option =
        c.text[c.pos] === '"'
          ? c.value("the option")
          : c.value("the option", / in (?=(role|label|testid|text|placeholder|css)=)/);
      c.keyword("in");
      return { op: "select", option, target: c.locator() };
    }
    case "press": {
      c.skipSpace();
      const start = c.pos;
      const key = c.word();
      if (!/^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/.test(key)) {
        c.failAt(
          start,
          c.pos,
          `"${key}" is not a key name.`,
          "Use a key like Enter, Tab, Escape or Control+A.",
        );
      }
      return { op: "press", key };
    }
    default: {
      if (c.peekWord() === "url") {
        c.word();
        const match = c.keyword("contains", "is") as "contains" | "is";
        return { op: "expectUrl", match, value: c.value("the URL text") };
      }
      const target = c.locator();
      const check = c.keyword("text", "contains", "count", ...STATES);
      if (check === "text" || check === "contains") {
        c.skipSpace();
        if (c.text[c.pos] !== '"') c.fail(`Expected the "quoted" text after "${check}".`);
        return { op: "expectText", target, match: check, value: c.value("the text") };
      }
      if (check === "count") {
        c.skipSpace();
        const start = c.pos;
        const n = c.word();
        if (!/^\d+$/.test(n))
          c.failAt(start, c.pos, `"${n}" is not a whole number.`, "Write a count like 3.");
        return { op: "expectCount", target, count: Number(n) };
      }
      return { op: "expectState", target, state: check as (typeof STATES)[number] };
    }
  }
}

/** Parses the text after `Exact:`. Invalid syntax is an EXACT_SYNTAX error at the exact spot. */
export function parseExactOp(
  text: string,
  map?: SourceMap,
  report?: Reporter,
): ExactOp | undefined {
  const cursor = new Cursor(text, map, report);
  try {
    const op = parseOp(cursor);
    if (!cursor.atEnd()) {
      cursor.fail(`Unexpected text "${text.slice(cursor.pos)}" at the end of the exact step.`);
    }
    return op;
  } catch (error) {
    if (!(error instanceof SyntaxProblem)) throw error;
    const start = Math.min(error.offset, text.length);
    const end = Math.max(
      Math.min(error.end, text.length),
      start === text.length ? start : start + 1,
    );
    report?.error("EXACT_SYNTAX", map?.range(start, end), error.message, error.fix);
    return undefined;
  }
}

const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const bare = (value: string) => (/^[^\s"[\]]+$/.test(value) ? value : quote(value));
/** Rest-of-line values print bare unless that would not read back the same. */
const rest = (value: string) =>
  value === "" || value.startsWith('"') || value.trim() !== value ? quote(value) : value;

export function printLocator(locator: Locator): string {
  if (locator.by === "role") {
    return `role=${locator.role}${locator.name === undefined ? "" : `[name=${quote(locator.name)}]`}`;
  }
  const value =
    locator.by === "testid" || locator.by === "css" ? bare(locator.value) : quote(locator.value);
  return `${locator.by}=${value}`;
}

/** Canonical text of an op (without the `Exact:` prefix). */
export function printExactOp<V>(op: ExactOp<V>, show: (value: V) => string): string {
  switch (op.op) {
    case "goto":
      return `goto ${rest(show(op.url))}`;
    case "click":
      return `click ${printLocator(op.target)}`;
    case "fill":
      return `fill ${printLocator(op.target)} with ${quote(show(op.value))}`;
    case "select":
      return `select ${quote(show(op.option))} in ${printLocator(op.target)}`;
    case "press":
      return `press ${op.key}`;
    case "expectUrl":
      return `expect url ${op.match} ${rest(show(op.value))}`;
    case "expectText":
      return `expect ${printLocator(op.target)} ${op.match} ${quote(show(op.value))}`;
    case "expectState":
      return `expect ${printLocator(op.target)} ${op.state}`;
    case "expectCount":
      return `expect ${printLocator(op.target)} count ${op.count}`;
  }
}

/** The templates inside an op, for reference checks and binding. */
export function opTemplates(op: ExactOp): Template[] {
  switch (op.op) {
    case "goto":
      return [op.url];
    case "fill":
    case "expectUrl":
    case "expectText":
      return [op.value];
    case "select":
      return [op.option];
    default:
      return [];
  }
}
