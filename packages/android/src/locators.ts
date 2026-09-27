import type { Screen, ScreenNode } from "./hierarchy.js";
import type { CandidatesResult, ElementFacts, LocatorCandidate, LocatorSpec } from "./types.js";

// The web harness's locator kinds, read the Android way (MOB-5 reuses the
// recording format): role + accessible name, label (the labelFor view), placeholder
// (the hint), alt (content description), title (tooltip), testId (the resource id,
// with or without its `package:id/` prefix), text, and css, which on Android is a
// class selector: `android.widget.Button` or `Button`, optionally with
// `[resource-id="…"]`, `[content-desc="…"]` or `[text="…"]`. Frame paths are
// ignored: windows are searched together, top window first.

const norm = (text: string) => text.replace(/\s+/g, " ").trim();

function textMatch(
  actual: string | undefined,
  wanted: string,
  exact: boolean | undefined,
): boolean {
  if (actual === undefined) return false;
  const a = norm(actual);
  const w = norm(wanted);
  // Like Playwright: exact compares whole strings; otherwise a case-insensitive substring.
  return exact === false ? a.toLowerCase().includes(w.toLowerCase()) : a === w;
}

interface CssSelector {
  cls: string;
  attributes: [string, string][];
}

export function parseCss(selector: string): CssSelector | null {
  const match = /^([A-Za-z_][\w.$]*)((?:\[[a-z-]+="[^"]*"\])*)$/.exec(selector.trim());
  if (!match) return null;
  const attributes = [...(match[2] ?? "").matchAll(/\[([a-z-]+)="([^"]*)"\]/g)].map(
    (m) => [m[1] as string, m[2] as string] as [string, string],
  );
  return { cls: match[1] as string, attributes };
}

function attribute(entry: ScreenNode, name: string): string | undefined {
  switch (name) {
    case "resource-id":
      return entry.node.rid;
    case "content-desc":
      return entry.node.desc;
    case "text":
      return entry.node.text;
    case "hint":
      return entry.node.hint;
    default:
      return undefined;
  }
}

function matches(entry: ScreenNode, spec: LocatorSpec): boolean {
  const node = entry.node;
  switch (spec.kind) {
    case "role":
      if (entry.role !== spec.role) return false;
      return spec.name === undefined || textMatch(entry.name, spec.name, spec.exact);
    case "label":
      return (
        textMatch(entry.label, spec.text, spec.exact) ||
        (entry.role === "textbox" && textMatch(entry.name, spec.text, spec.exact))
      );
    case "placeholder":
      return textMatch(node.hint, spec.text, spec.exact);
    case "alt":
      return textMatch(node.desc, spec.text, spec.exact);
    case "title":
      return textMatch(node.tooltip ?? node.pane, spec.text, spec.exact);
    case "testId":
      return node.rid === spec.value || entry.testId === spec.value;
    case "text":
      return entry.role !== "textbox" && textMatch(node.text, spec.text, spec.exact);
    case "css": {
      const css = parseCss(spec.selector);
      if (!css) return false;
      const cls = css.cls.includes(".")
        ? node.cls === css.cls
        : node.cls.endsWith(`.${css.cls}`) || node.cls === css.cls;
      return cls && css.attributes.every(([name, value]) => attribute(entry, name) === value);
    }
  }
}

/** Every shown node the locator matches, top window first, in document order within a window. */
export function matchAll(screen: Screen, spec: LocatorSpec): ScreenNode[] {
  const found: ScreenNode[] = [];
  for (const entry of screen.shown()) if (matches(entry, spec)) found.push(entry);
  return found.sort((a, b) => b.frame - a.frame || a.index - b.index);
}

/** The one node a locator (with `nth`) points at; `count` says how many matched. */
export function resolveLocator(
  screen: Screen,
  spec: LocatorSpec,
): { entry: ScreenNode | undefined; count: number } {
  const all = matchAll(screen, spec);
  if (spec.nth !== undefined) return { entry: all[spec.nth], count: all.length };
  return { entry: all.length === 1 ? all[0] : undefined, count: all.length };
}

/** Locators for a node in the web harness's order (role and name first, css last). */
export function candidateSpecs(screen: Screen, entry: ScreenNode): LocatorSpec[] {
  const node = entry.node;
  const specs: LocatorSpec[] = [];
  if (entry.name && entry.role !== "text" && entry.role !== "generic") {
    specs.push({ kind: "role", role: entry.role, name: entry.name, exact: true });
  }
  if (entry.label) specs.push({ kind: "label", text: entry.label, exact: true });
  if (node.hint) specs.push({ kind: "placeholder", text: norm(node.hint), exact: true });
  if (node.desc) specs.push({ kind: "alt", text: norm(node.desc), exact: true });
  if (node.tooltip) specs.push({ kind: "title", text: norm(node.tooltip), exact: true });
  if (entry.testId) specs.push({ kind: "testId", value: entry.testId });
  if (node.text && entry.role !== "textbox")
    specs.push({ kind: "text", text: norm(node.text), exact: true });
  const css = node.rid ? `${node.cls}[resource-id="${node.rid}"]` : node.cls;
  specs.push({ kind: "css", selector: css });
  // Make every candidate point at exactly this node.
  return specs.map((spec) => {
    const all = matchAll(screen, spec);
    const at = all.indexOf(entry);
    return all.length > 1 && at >= 0 ? { ...spec, nth: at } : spec;
  });
}

/** The closest heading, dialog title or label above the node: what it is "under". */
export function anchorText(screen: Screen, entry: ScreenNode): string {
  if (entry.label) return entry.label;
  let best = "";
  for (const other of screen.shown()) {
    if (other.index >= entry.index) break;
    if (other.node.window !== entry.node.window) continue;
    if (other.role === "heading" && other.name) best = other.name;
  }
  if (best) return best;
  const window = screen.dump.windows.find((w) => w.id === entry.node.window);
  return (window?.title ?? "").trim();
}

export function factsOf(
  screen: Screen,
  entry: ScreenNode,
  redact: (text: string) => string,
): ElementFacts {
  const node = entry.node;
  const attributes: Record<string, string> = { class: node.cls, package: screen.packageOf(entry) };
  if (node.rid) attributes["resource-id"] = node.rid;
  if (node.desc) attributes["content-desc"] = redact(node.desc);
  if (node.hint) attributes.hint = redact(node.hint);
  if (node.tooltip) attributes.tooltip = redact(node.tooltip);
  if (node.flags.includes("password")) attributes.password = "true";
  if (node.inputType !== undefined) attributes["input-type"] = String(node.inputType);
  const [l, t, r, b] = node.bounds;
  return {
    role: entry.role,
    name: redact(entry.name),
    tag: node.cls,
    attributes,
    // Never a field's value.
    text: entry.role === "textbox" ? "" : redact(norm(node.text ?? "")),
    anchorText: redact(anchorText(screen, entry)),
    framePath: [],
    box: r > l && b > t ? { x: l, y: t, width: r - l, height: b - t } : null,
  };
}

export function candidatesFor(
  screen: Screen,
  entry: ScreenNode,
  redact: (text: string) => string,
): CandidatesResult {
  const candidates: LocatorCandidate[] = candidateSpecs(screen, entry).map((spec) => {
    const count = matchAll(screen, spec).length;
    const scrubbed = scrubSpec(spec, redact);
    return { locator: scrubbed, unique: count === 1, matches: count };
  });
  return { status: "ok", candidates, facts: factsOf(screen, entry, redact) };
}

function scrubSpec(spec: LocatorSpec, redact: (text: string) => string): LocatorSpec {
  switch (spec.kind) {
    case "role":
      return spec.name === undefined ? spec : { ...spec, name: redact(spec.name) };
    case "testId":
      return spec;
    case "css":
      return { ...spec, selector: redact(spec.selector) };
    default:
      return { ...spec, text: redact(spec.text) };
  }
}
