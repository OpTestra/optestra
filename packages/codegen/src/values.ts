import type { Template } from "@optestra/spec";
import { BUILT_IN_GENERATORS } from "@optestra/spec";
import {
  call,
  type Expr,
  id,
  isIdentifier,
  member,
  raw,
  str,
  tpl,
  quote,
  awaited,
} from "./print/js.js";

// Values in recordings and test files are templates (REP-7). The spec keeps
// them as code: data and params become objects declared once per test or flow
// call, generators (`unique`, `faker`) are called at run time (ENV-3), secrets
// are typed by name through the secrets helper (SEC-1), never as literals.

export type Part = { text: string } | { ref: string };

const REF = /\{\{\s*([a-zA-Z]+\.[A-Za-z0-9_.-]+)\s*\}\}/g;

/** Splits a recording template (`\{{` = literal `{{`) into text and references. */
export function recordingParts(template: string): Part[] {
  const parts: Part[] = [];
  let text = "";
  let last = 0;
  for (const match of template.matchAll(REF)) {
    const start = match.index ?? 0;
    if (start > 0 && template[start - 1] === "\\") continue;
    text += template.slice(last, start);
    last = start + match[0].length;
    if (text) parts.push({ text });
    text = "";
    parts.push({ ref: match[1] as string });
  }
  text += template.slice(last);
  if (text) parts.push({ text });
  return parts.map((part) =>
    "text" in part ? { text: part.text.replace(/\\\{\{/g, "{{") } : part,
  );
}

/** Parts of a parsed test-file template. */
export function templateParts(template: Template): Part[] {
  return template.segments.map((segment) =>
    segment.kind === "text" ? { text: segment.text } : { ref: `${segment.ns}.${segment.name}` },
  );
}

/** What a value becomes in code. */
export type Value =
  | { kind: "text"; expr: Expr }
  | { kind: "secret"; name: string }
  | { kind: "unsupported"; reason: string };

/** A value's kind as far as it can be known statically. */
type Kind = { kind: "text" } | { kind: "secret"; name: string } | { kind: "mixed" };

/** One place values can be referenced from: the test itself or one flow call. */
export interface Scope {
  /** JS name of the data object (e.g. `data`, `loginData`). */
  dataVar: string;
  data: Record<string, Part[]>;
  /** JS name of the params object (e.g. `loginParams`); flows only. */
  paramsVar: string;
  /** Param name → its template and the scope it is evaluated in. */
  params: Record<string, { parts: Part[]; scope: Scope }>;
  /** Keys read by generated code (only those are declared). */
  usedData: Set<string>;
  usedParams: Set<string>;
  /** Data keys declared as their own constants (a data value that uses another). */
  aliases?: Map<string, string>;
}

export function createScope(
  dataVar: string,
  data: Record<string, Part[]>,
  paramsVar = "params",
  params: Scope["params"] = {},
): Scope {
  return { dataVar, data, paramsVar, params, usedData: new Set(), usedParams: new Set() };
}

/** Helpers the generated code reaches for; the caller adds them to the test's fixtures. */
export interface Needs {
  fixtures: Set<"page" | "values" | "secrets" | "network" | "inbox">;
  imports: Set<string>;
}

/** Step-local values: generator and inbox reads, declared at the top of a step. */
export class StepLocals {
  readonly statements: Array<{ name: string; init: Expr }> = [];
  readonly #byRef = new Map<string, string>();
  readonly #taken: Set<string>;

  constructor(taken: Set<string>) {
    this.#taken = taken;
  }

  get(ref: string, init: () => Expr): Expr {
    let name = this.#byRef.get(ref);
    if (!name) {
      name = uniqueName(camel(ref.split(".")), this.#taken);
      this.#byRef.set(ref, name);
      this.statements.push({ name, init: init() });
    }
    return id(name);
  }
}

export function camel(words: readonly string[]): string {
  const parts = words
    .flatMap((word) => word.split(/[^A-Za-z0-9]+/))
    .filter(Boolean)
    .map((word, i) =>
      i === 0 ? word[0]?.toLowerCase() + word.slice(1) : word[0]?.toUpperCase() + word.slice(1),
    );
  const name = parts.join("") || "value";
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

export function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

function access(object: string, key: string): Expr {
  return isIdentifier(key) ? member(id(object), key) : raw(`${object}[${quote(key)}]`);
}

const GENERATORS = new Set(Object.keys(BUILT_IN_GENERATORS));
const INBOX_MEMBERS = new Set(["code", "link"]);

export interface ResolveContext {
  needs: Needs;
  /** Where step-local values go; absent while declaring data and params objects. */
  locals?: StepLocals;
}

/** The static kind of a reference, following data and params to their templates. */
function refKind(ref: string, scope: Scope, seen: Set<string>): Kind {
  const [ns, ...rest] = ref.split(".");
  const name = rest.join(".");
  if (ns === "secret") return { kind: "secret", name };
  if (ns === "data" && Object.hasOwn(scope.data, name)) {
    const key = `${scope.dataVar}.${name}`;
    if (seen.has(key)) return { kind: "text" };
    return partsKind(scope.data[name] as Part[], scope, new Set([...seen, key]));
  }
  if (ns === "params" && Object.hasOwn(scope.params, name)) {
    const param = scope.params[name] as Scope["params"][string];
    return partsKind(param.parts, param.scope, seen);
  }
  return { kind: "text" };
}

function partsKind(parts: readonly Part[], scope: Scope, seen = new Set<string>()): Kind {
  const kinds = parts.map((part) =>
    "text" in part ? { kind: "text" as const } : refKind(part.ref, scope, seen),
  );
  const secrets = kinds.filter((kind) => kind.kind !== "text");
  if (secrets.length === 0) return { kind: "text" };
  if (parts.length === 1 && secrets[0]?.kind === "secret") return secrets[0];
  return { kind: "mixed" };
}

/** True when the data key or param holds text (not a secret) and can live in the object. */
export function isTextValue(parts: readonly Part[], scope: Scope): boolean {
  return partsKind(parts, scope).kind === "text";
}

/**
 * The code for a template in `scope`. Text becomes a string, a template
 * literal or a reference to a data/params object; a lone secret becomes its
 * name for the secrets helper.
 */
export function resolveValue(parts: readonly Part[], scope: Scope, context: ResolveContext): Value {
  const kind = partsKind(parts, scope);
  if (kind.kind === "secret") return { kind: "secret", name: kind.name };
  if (kind.kind === "mixed") {
    return { kind: "unsupported", reason: "a secret must be the whole value, typed on its own" };
  }
  const pieces: Array<string | Expr> = [];
  for (const part of parts) {
    if ("text" in part) {
      pieces.push(part.text);
      continue;
    }
    const piece = resolveRef(part.ref, scope, context);
    if (typeof piece === "object" && "unsupported" in piece) {
      return { kind: "unsupported", reason: piece.unsupported };
    }
    pieces.push(piece);
  }
  const merged: Array<string | Expr> = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (typeof piece === "string" && typeof last === "string")
      merged[merged.length - 1] = last + piece;
    else merged.push(piece);
  }
  if (merged.length === 0) return { kind: "text", expr: str("") };
  if (merged.length === 1) {
    const only = merged[0] as string | Expr;
    return { kind: "text", expr: typeof only === "string" ? str(only) : only };
  }
  return { kind: "text", expr: tpl(merged) };
}

function resolveRef(
  ref: string,
  scope: Scope,
  context: ResolveContext,
): string | Expr | { unsupported: string } {
  const [ns, ...rest] = ref.split(".");
  const name = rest.join(".");
  switch (ns) {
    case "data":
      if (!Object.hasOwn(scope.data, name)) return `{{${ref}}}`;
      scope.usedData.add(name);
      if (scope.aliases?.has(name)) return id(scope.aliases.get(name) as string);
      return access(scope.dataVar, name);
    case "params":
      if (!Object.hasOwn(scope.params, name)) return `{{${ref}}}`;
      scope.usedParams.add(name);
      return access(scope.paramsVar, name);
    case "env":
      context.needs.fixtures.add("values");
      return call("values.env", str(name));
    case "unique":
    case "faker": {
      if (!GENERATORS.has(ref)) {
        return { unsupported: `{{${ref}}} is a custom generator the spec doesn't have` };
      }
      context.needs.fixtures.add("values");
      const generate = () => call(`values.${ns}.${name}`);
      return context.locals ? context.locals.get(ref, generate) : generate();
    }
    case "inbox": {
      if (!INBOX_MEMBERS.has(name) || !context.locals) {
        return { unsupported: `{{${ref}}} is read by the test runner only` };
      }
      context.needs.fixtures.add("inbox");
      return context.locals.get(ref, () => awaited(call(`inbox.${name}`)));
    }
    default:
      return `{{${ref}}}`;
  }
}
