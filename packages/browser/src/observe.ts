import type {
  ElementStates,
  ElementSummary,
  Observation,
  ObservedElement,
  ObservedFrame,
  Refusal,
} from "./types.js";

// Observation (MOD-3): Playwright's AI snapshot (`ariaSnapshotJSON({ mode: "ai" })`,
// public since 1.59) covers the whole page, iframes and open shadow roots. We
// filter it to what an agent needs and give every element our own short ref.

/** One node of Playwright's AI snapshot JSON. Strings are text fragments. */
export interface AriaNode {
  role: string;
  name?: string;
  text?: string;
  ref?: string;
  cursor?: string;
  url?: string;
  placeholder?: string;
  box?: { x: number; y: number; width: number; height: number };
  children?: Array<AriaNode | string>;
  checked?: boolean | "mixed";
  disabled?: boolean;
  expanded?: boolean;
  pressed?: boolean | "mixed";
  selected?: boolean;
  invalid?: boolean;
  active?: boolean;
  level?: number;
}

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
]);

const LANDMARK_ROLES = new Set([
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "complementary",
  "region",
  "form",
  "search",
]);

/** Kept even without text: structure an agent navigates by. */
const STRUCTURE_ROLES = new Set([
  ...LANDMARK_ROLES,
  "heading",
  "dialog",
  "alertdialog",
  "iframe",
  "table",
]);

/** Pure containers: dropped unless they carry text of their own; children move up. */
const CONTAINER_ROLES = new Set([
  "generic",
  "group",
  "list",
  "rowgroup",
  "row",
  "none",
  "presentation",
  "document",
  "application",
]);

const STATE_KEYS = [
  "checked",
  "disabled",
  "expanded",
  "pressed",
  "selected",
  "invalid",
  "active",
  "level",
] as const;

/** Where a ref points: Playwright's own `aria-ref` and the frame it is in. */
export interface RefTarget {
  ariaRef: string;
  frame: number;
  element: ObservedElement;
}

export interface BuildContext {
  url: string;
  title: string;
  observedAt: string;
  refused: Refusal[];
  maxElements: number;
  redact: (text: string) => string;
  /** URL of the frame inside an iframe element and the iframe's title, by its aria ref. */
  frameInfo: (ariaRef: string) => { url: string; title: string };
}

export interface BuiltObservation {
  observation: Observation;
  refs: Map<string, RefTarget>;
}

const clean = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed === "" ? undefined : collapsed;
};

function statesOf(node: AriaNode): ElementStates {
  const states: ElementStates = {};
  for (const key of STATE_KEYS) {
    const value = node[key];
    if (value !== undefined && value !== false) (states as Record<string, unknown>)[key] = value;
  }
  return states;
}

/** Turns a snapshot into an Observation and a ref table. Pure: no browser needed. */
export function buildObservation(
  nodes: Array<AriaNode | string>,
  ctx: BuildContext,
): BuiltObservation {
  const elements: ObservedElement[] = [];
  const frames: ObservedFrame[] = [{ url: ctx.redact(ctx.url), parentRef: null }];
  const refs = new Map<string, RefTarget>();
  let truncated = false;

  const push = (element: ObservedElement, ariaRef: string | undefined): void => {
    if (elements.length >= ctx.maxElements) {
      truncated = true;
      return;
    }
    if (ariaRef) {
      element.ref = `e${refs.size + 1}`;
      refs.set(element.ref, { ariaRef, frame: element.frame, element });
    }
    elements.push(element);
  };

  const walk = (node: AriaNode | string, depth: number, frame: number): void => {
    if (typeof node === "string") {
      const text = clean(node);
      if (text)
        push(
          {
            role: "text",
            name: "",
            depth,
            text: ctx.redact(text),
            states: {},
            interactive: false,
            frame,
          },
          undefined,
        );
      return;
    }
    const role = node.role;
    const frameInfo = role === "iframe" && node.ref ? ctx.frameInfo(node.ref) : undefined;
    const name = clean(node.name) ?? clean(frameInfo?.title) ?? "";
    const text = clean(node.text);
    const clickable = node.cursor === "pointer";
    const interactive = INTERACTIVE_ROLES.has(role) || clickable;
    const keep =
      interactive ||
      STRUCTURE_ROLES.has(role) ||
      (role === "img" && name !== "") ||
      (!CONTAINER_ROLES.has(role) && (name !== "" || text !== undefined)) ||
      (CONTAINER_ROLES.has(role) && text !== undefined);

    let childDepth = depth;
    let childFrame = frame;
    if (keep) {
      const element: ObservedElement = {
        role,
        name: ctx.redact(name),
        depth,
        states: statesOf(node),
        interactive,
        frame,
      };
      if (text !== undefined) element.text = ctx.redact(text);
      if (node.url !== undefined) element.url = ctx.redact(node.url);
      if (node.placeholder !== undefined) element.placeholder = ctx.redact(node.placeholder);
      if (node.box) element.box = node.box;
      push(element, node.ref);
      childDepth = depth + 1;
      if (role === "iframe") {
        childFrame = frames.length;
        frames.push({
          url: ctx.redact(frameInfo?.url ?? ""),
          parentRef: element.ref ?? null,
        });
      }
    }
    for (const child of node.children ?? []) walk(child, childDepth, childFrame);
  };

  for (const node of nodes) walk(node, 0, 0);

  return {
    observation: {
      untrusted: true,
      url: ctx.redact(ctx.url),
      title: ctx.redact(ctx.title),
      observedAt: ctx.observedAt,
      frames,
      elements,
      refused: ctx.refused,
      truncated,
    },
    refs,
  };
}

/** Focus (`active`) moves with every click, so it is not a change of the page. */
const signature = (s: ElementSummary, states?: ElementStates): string => {
  const { active: _focus, ...rest } = states ?? {};
  return JSON.stringify([s.role, s.name, s.text ?? "", rest]);
};

/** Elements in `after` but not `before` (added) and the reverse (removed), as multisets. */
export function diffElements(
  before: readonly ObservedElement[],
  after: readonly ObservedElement[],
  limit = 50,
): { added: ElementSummary[]; removed: ElementSummary[] } {
  const count = new Map<string, number>();
  for (const element of before) {
    const key = signature(element, element.states);
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const added: ElementSummary[] = [];
  for (const element of after) {
    const key = signature(element, element.states);
    const left = count.get(key) ?? 0;
    if (left > 0) count.set(key, left - 1);
    else if (added.length < limit) added.push(summaryOf(element));
  }
  const removed: ElementSummary[] = [];
  const remaining = new Map(count);
  for (const element of before) {
    const key = signature(element, element.states);
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      if (removed.length < limit) removed.push(summaryOf(element));
    }
  }
  return { added, removed };
}

function summaryOf(element: ObservedElement): ElementSummary {
  const summary: ElementSummary = { role: element.role, name: element.name };
  if (element.text !== undefined) summary.text = element.text;
  return summary;
}
