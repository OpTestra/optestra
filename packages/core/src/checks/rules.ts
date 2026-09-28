import type { CheckOp, Locator } from "@testament/recording";
import type { Observation } from "../target/harness.js";
import phrases from "./phrases.json" with { type: "json" };

// The rule compiler (LOOP-2): common Expect phrasings become typed checks by
// deterministic rules, with no model. The phrases live in phrases.json; the
// builders here pick the concrete locator by looking at the live page (the
// observation, plus read-only probes), preferring role and label locators like
// LOOP-1's candidates. The line itself is never changed (HEAL-3).

/** Evaluates a candidate op once on the current page (read-only). */
export type Probe = (
  op: CheckOp,
  options?: { timeoutMs?: number },
) => Promise<{ passed: boolean; matched?: number }>;

export interface RuleContext {
  observation: Observation;
  probe: Probe;
}

export type RuleResult =
  | { ok: true; op: CheckOp; rule: string }
  | {
      ok: false;
      /** "secret": the line uses a secret (never compiled, never sent to a model). */
      reason: "no_rule" | "secret";
      /** Rules whose phrase matched but that couldn't find what the line refers to. */
      tried: string[];
      message: string;
    };

type Groups = Record<string, string | undefined>;
type Builder = (groups: Groups, ctx: RuleContext) => Promise<CheckOp | null>;

const QUOTE = '["“”]';
/** How long a rule waits for the expected text to show up before choosing where it lives. */
const PRESENCE_WAIT_MS = 3_000;

interface CompiledRule {
  id: string;
  build: string;
  patterns: RegExp[];
}

export const RULES: readonly CompiledRule[] = phrases.rules.map((rule) => ({
  id: rule.id,
  build: rule.build,
  patterns: rule.patterns.map((pattern) => new RegExp(pattern.replace(/Q/g, QUOTE), "i")),
}));

const SELECTORS = phrases.selectors;
const PAGE: Locator = { kind: "css", selector: SELECTORS.page };
const containers = phrases.containers as Record<
  string,
  { roles: string[]; fallbacks: string[]; items?: "list" | "table" }
>;

/** Elements whose text names their container. */
const LABEL_ROLES = new Set(["caption", "legend", "heading"]);

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Page helpers ─────────────────────────────────────────────────────────────

async function exists(ctx: RuleContext, target: Locator, scope?: Locator): Promise<number> {
  const { matched } = await ctx.probe(
    { type: "count", target, min: 0, ...(scope ? { scope } : {}) },
    { timeoutMs: 0 },
  );
  return matched ?? 0;
}

async function holds(ctx: RuleContext, op: CheckOp, timeoutMs = 0): Promise<boolean> {
  return (await ctx.probe(op, { timeoutMs })).passed;
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word && word !== "the" && word !== "a" && word !== "an")
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));

/** "projects" names "Projects"; "orders" names "Your orders". */
export function namesMatch(noun: string, name: string): boolean {
  const want = words(noun);
  const have = words(name);
  if (want.length === 0 || have.length === 0) return false;
  return want.every((word) => have.includes(word)) || have.every((word) => want.includes(word));
}

/** Names on the page (headings, landmarks, tables…) that the noun refers to, in page order. */
function namesFor(noun: string, observation: Observation): string[] {
  const names: string[] = [];
  for (const element of observation.elements) {
    if (element.role === "text" || element.interactive) continue;
    // A table's caption and a group's legend name it, but show up as text.
    const name = element.name || (LABEL_ROLES.has(element.role) ? (element.text ?? "") : "");
    if (name && namesMatch(noun, name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The container a phrase like "the projects list" refers to. */
async function findContainer(
  ctx: RuleContext,
  noun: string | undefined,
  kind: string,
): Promise<Locator | null> {
  const info = containers[kind.toLowerCase()];
  if (!info) return null;
  const names = noun ? namesFor(noun, ctx.observation) : [];
  for (const role of [...info.roles, ...info.fallbacks]) {
    for (const name of names) {
      const locator: Locator = { kind: "role", role, name, exact: true };
      if ((await exists(ctx, locator)) >= 1) return locator;
    }
  }
  // No named one: the only container of that kind on the page.
  for (const role of info.roles) {
    const locator: Locator = { kind: "role", role };
    if ((await exists(ctx, locator)) === 1) return locator;
  }
  return null;
}

/** The first candidate whose op holds now; else `fallback`. */
async function firstHolding(
  ctx: RuleContext,
  candidates: CheckOp[],
  fallback: CheckOp | null,
): Promise<CheckOp | null> {
  for (const op of candidates) if (await holds(ctx, op)) return op;
  return fallback;
}

const visibleText = (text: string): CheckOp => ({
  type: "text",
  target: PAGE,
  match: "contains",
  value: text,
});

// ── Builders ─────────────────────────────────────────────────────────────────

const builders: Record<string, Builder> = {
  async url(g) {
    const value = g.value ?? g.bare;
    if (!value) return null;
    const how = (g.match ?? "is").toLowerCase();
    if (how === "contains" || how === "includes") return { type: "url", match: "contains", value };
    if (how === "matches") return { type: "url", match: "matches", value };
    if (how === "ends with")
      return { type: "url", match: "matches", value: `${escapeRegex(value)}$` };
    if (how === "starts with") {
      const source = value.startsWith("/")
        ? `^[a-z]+://[^/]+${escapeRegex(value)}`
        : `^${escapeRegex(value)}`;
      return { type: "url", match: "matches", value: source };
    }
    return { type: "url", match: "is", value };
  },

  // The main heading: an h1 when the page has one, else any heading.
  async heading(g, ctx) {
    const text = g.text as string;
    const hasH1 = ctx.observation.elements.some(
      (e) => e.role === "heading" && e.states.level === 1,
    );
    const target: Locator = hasH1
      ? { kind: "role", role: "heading", level: 1 }
      : { kind: "role", role: "heading" };
    return { type: "text", target, match: "equals", value: text };
  },

  async dialog(g, ctx) {
    const name = g.name as string;
    const dialog: Locator = { kind: "role", role: "dialog", name, exact: true };
    const alert: Locator = { kind: "role", role: "alertdialog", name, exact: true };
    const target =
      (await exists(ctx, dialog)) === 0 && (await exists(ctx, alert)) > 0 ? alert : dialog;
    return { type: "element_state", target, state: "visible" };
  },

  // A status or alert region holding the text, else the page's visible text.
  async message(g, ctx) {
    const text = g.text as string;
    await holds(ctx, visibleText(text), PRESENCE_WAIT_MS);
    const regions: CheckOp[] = ["status", "alert"].map((role) => ({
      type: "text",
      target: { kind: "role", role },
      match: "contains",
      value: text,
    }));
    return firstHolding(ctx, regions, visibleText(text));
  },

  // An alert, or an element marked as an error, holding the text.
  async error(g, ctx) {
    const text = g.text as string;
    const present = await holds(ctx, visibleText(text), PRESENCE_WAIT_MS);
    const alert: CheckOp = {
      type: "text",
      target: { kind: "role", role: "alert" },
      match: "contains",
      value: text,
    };
    const marked: CheckOp = {
      type: "text",
      target: { kind: "css", selector: SELECTORS.errorMarked },
      match: "contains",
      value: text,
    };
    // Not on the page at all: keep the faithful form; it fails, and the user sees why.
    return firstHolding(ctx, [alert, marked], present ? null : alert);
  },

  async element(g) {
    const role = (phrases.roles as Record<string, string>)[(g.role ?? "").toLowerCase()];
    const state = (phrases.states as Record<string, string>)[(g.state ?? "").toLowerCase()];
    if (!role || !state || !g.name) return null;
    return {
      type: "element_state",
      target: { kind: "role", role, name: g.name, exact: true },
      state: state as Extract<CheckOp, { type: "element_state" }>["state"],
    };
  },

  async containerCount(g, ctx) {
    const kind = (g.kind ?? "").toLowerCase();
    const container = await findContainer(ctx, g.noun, kind);
    const items = containers[kind]?.items;
    if (!container || !items) return null;
    const target: Locator =
      items === "table"
        ? { kind: "css", selector: SELECTORS.tableRows }
        : { kind: "role", role: "listitem" };
    return { type: "count", target, n: Number(g.n), scope: container };
  },

  async row(g, ctx) {
    const kind = (g.kind ?? "").toLowerCase();
    const ordinal = (g.ordinal ?? "").toLowerCase();
    const nth =
      (phrases.ordinals as Record<string, number>)[ordinal] ??
      (/^\d+/.test(ordinal) ? Number.parseInt(ordinal, 10) - 1 : undefined);
    if (nth === undefined || nth < 0) return null;
    // "the first order in the table": the noun may sit on the item ("order") or the table.
    const container =
      (await findContainer(ctx, g.noun ?? g.item, kind)) ??
      (g.noun ? await findContainer(ctx, g.item, kind) : null);
    const items = containers[kind]?.items;
    if (!container || !items) return null;
    const target: Locator =
      items === "table"
        ? { kind: "css", selector: SELECTORS.tableRows, nth }
        : { kind: "role", role: "listitem", nth };
    // "A-1002 ($8.90)": every part must show in the row, in order.
    const parts = (g.rest ?? "")
      .split(/\s*[(),;]\s*|\s+and\s+/)
      .map((part) => part.trim().replace(/^["“](.*)["”]$/, "$1"))
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1)
      return {
        type: "text",
        target,
        match: "contains",
        value: parts[0] as string,
        scope: container,
      };
    return {
      type: "text",
      target,
      match: "matches",
      value: parts.map(escapeRegex).join("[\\s\\S]*"),
      scope: container,
    };
  },

  async containerText(g, ctx) {
    const container = await findContainer(ctx, g.noun, g.kind ?? "");
    if (!container) return null;
    return { type: "text", target: container, match: "contains", value: g.text as string };
  },

  async fieldValue(g, ctx) {
    const label = g.label as string;
    const match = (phrases.fieldMatch as Record<string, "equals" | "contains">)[
      (g.match ?? "").toLowerCase()
    ];
    if (!match) return null;
    const candidates: Locator[] = [
      { kind: "label", text: label, exact: true },
      { kind: "role", role: "textbox", name: label, exact: true },
      { kind: "role", role: "combobox", name: label, exact: true },
    ];
    let target = candidates[0] as Locator;
    for (const candidate of candidates) {
      if ((await exists(ctx, candidate)) >= 1) {
        target = candidate;
        break;
      }
    }
    return { type: "value", target, match, value: g.text ?? "" };
  },

  async noText(g) {
    return {
      type: "element_state",
      target: { kind: "text", text: g.text as string, exact: false },
      state: "hidden",
    };
  },

  async visibleText(g) {
    return visibleText(g.text as string);
  },
};

/** The phrase rule that matches a line, and its named groups (no page needed). */
export function matchRules(line: string): Array<{ rule: CompiledRule; groups: Groups }> {
  const text = line.trim();
  const found: Array<{ rule: CompiledRule; groups: Groups }> = [];
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (match) {
        found.push({ rule, groups: { ...match.groups } });
        break;
      }
    }
  }
  return found;
}

/**
 * Compiles one Expect/Soft line (a template: `{{refs}}` by name) by rules.
 * Never alters the line; returns the op, or why no rule applies.
 */
export async function compileByRules(line: string, ctx: RuleContext): Promise<RuleResult> {
  if (/(?<!\\)\{\{\s*secret\./.test(line)) {
    return {
      ok: false,
      reason: "secret",
      tried: [],
      message:
        "The expectation uses a secret. Secrets are never check values, so it can't be checked.",
    };
  }
  const tried: string[] = [];
  for (const { rule, groups } of matchRules(line)) {
    const builder = builders[rule.build];
    if (!builder) continue;
    const op = await builder(groups, ctx);
    if (op) return { ok: true, op, rule: rule.id };
    tried.push(rule.id);
  }
  return {
    ok: false,
    reason: "no_rule",
    tried,
    message: tried.length
      ? `The phrase matched rule${tried.length > 1 ? "s" : ""} ${tried.join(", ")}, but what it refers to wasn't found on the page.`
      : "No phrase rule matches this line.",
  };
}
