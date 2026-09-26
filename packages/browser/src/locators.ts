import type { FrameLocator, Locator, Page } from "playwright";
import type { ElementFacts, LocatorSpec, ObservedElement } from "./types.js";

// Locator specs ↔ Playwright locators, and ranked candidates for an element in
// Playwright's own priority order: role+name, label, placeholder, alt, title,
// test id, text, CSS last.

type Scope = Page | FrameLocator;
type AriaRole = Parameters<Page["getByRole"]>[0];

/** Roles a role locator can't usefully target. */
const NO_ROLE_LOCATOR = new Set(["generic", "text", "none", "presentation", "iframe", "paragraph"]);
const MAX_TEXT = 80;

function inScope(scope: Scope, spec: LocatorSpec): Locator {
  const exact = "exact" in spec ? (spec.exact ?? true) : true;
  switch (spec.kind) {
    case "role":
      return scope.getByRole(
        spec.role as AriaRole,
        spec.name === undefined ? {} : { name: spec.name, exact },
      );
    case "label":
      return scope.getByLabel(spec.text, { exact });
    case "placeholder":
      return scope.getByPlaceholder(spec.text, { exact });
    case "alt":
      return scope.getByAltText(spec.text, { exact });
    case "title":
      return scope.getByTitle(spec.text, { exact });
    case "testId":
      return scope.getByTestId(spec.value);
    case "text":
      return scope.getByText(spec.text, { exact });
    case "css":
      return scope.locator(spec.selector);
  }
}

/** The Playwright locator for a spec, resolved through its frame path. */
export function toLocator(page: Page, spec: LocatorSpec): Locator {
  let scope: Scope = page;
  for (const frame of spec.frame ?? []) {
    let element = inScope(scope, frame);
    if (frame.nth !== undefined) element = element.nth(frame.nth);
    scope = element.contentFrame();
  }
  const locator = inScope(scope, spec);
  return spec.nth === undefined ? locator : locator.nth(spec.nth);
}

/** Facts read from the element itself (inside its frame). */
export interface RawFacts {
  tag: string;
  attributes: Record<string, string>;
  text: string;
  label: string;
  anchorText: string;
  css: string;
}

const ATTRIBUTES = [
  "id",
  "name",
  "type",
  "role",
  "aria-label",
  "placeholder",
  "title",
  "alt",
  "href",
  "src",
  "for",
  "data-testid",
  "class",
];

/** Runs in the page (inside the element's frame). Reads no values of fields. */
export function readFacts(element: Element, names: string[]): RawFacts {
  const attributes: Record<string, string> = {};
  for (const name of names) {
    const value = element.getAttribute(name);
    if (value !== null) attributes[name] = value.slice(0, 200);
  }
  const textOf = (node: Element | null | undefined) =>
    (node && "innerText" in node ? (node as HTMLElement).innerText : (node?.textContent ?? ""))
      .replace(/\s+/g, " ")
      .trim();
  const tag = element.tagName.toLowerCase();
  const isField = tag === "input" || tag === "textarea" || tag === "select";
  const labels = (element as HTMLInputElement).labels;
  let label = labels?.[0] ? textOf(labels[0]) : "";
  const labelledBy = element.getAttribute("aria-labelledby");
  if (!label && labelledBy) {
    label = labelledBy
      .split(/\s+/)
      .map((id) => textOf(element.ownerDocument.getElementById(id)))
      .join(" ")
      .trim();
  }
  let anchorText = "";
  for (let node = element.parentElement; node && !anchorText; node = node.parentElement) {
    const labelAttr = node.getAttribute("aria-label");
    if (labelAttr) {
      anchorText = labelAttr;
      break;
    }
    for (const heading of Array.from(
      node.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading],legend,caption"),
    )) {
      if (!heading.contains(element)) {
        anchorText = textOf(heading);
        break;
      }
    }
  }
  const cssPath = (target: Element): string => {
    const parts: string[] = [];
    for (
      let node: Element | null = target;
      node && node.nodeType === 1;
      node = node.parentElement
    ) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`#${node.id}`);
        break;
      }
      const name = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (!parent) {
        parts.unshift(name);
        break;
      }
      const same = Array.from(parent.children).filter((child) => child.tagName === node?.tagName);
      parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(node) + 1})` : name);
    }
    return parts.join(" > ");
  };
  return {
    tag,
    attributes,
    text: isField ? "" : textOf(element).slice(0, 200),
    label: label.slice(0, 200),
    anchorText: anchorText.slice(0, 200),
    css: cssPath(element),
  };
}

export const FACT_ATTRIBUTES = ATTRIBUTES;

/** Candidate specs in priority order (uniqueness is checked by the caller). */
export function candidateSpecs(
  element: Pick<ObservedElement, "role" | "name">,
  raw: RawFacts,
  frame: readonly LocatorSpec[],
): LocatorSpec[] {
  const scoped = (spec: LocatorSpec): LocatorSpec => (frame.length ? { ...spec, frame } : spec);
  const specs: LocatorSpec[] = [];
  const a = raw.attributes;
  if (!NO_ROLE_LOCATOR.has(element.role) && element.name) {
    specs.push(scoped({ kind: "role", role: element.role, name: element.name, exact: true }));
  }
  const label = raw.label || a["aria-label"];
  if (label) specs.push(scoped({ kind: "label", text: label, exact: true }));
  if (a.placeholder) specs.push(scoped({ kind: "placeholder", text: a.placeholder, exact: true }));
  if (a.alt) specs.push(scoped({ kind: "alt", text: a.alt, exact: true }));
  if (a.title) specs.push(scoped({ kind: "title", text: a.title, exact: true }));
  if (a["data-testid"]) specs.push(scoped({ kind: "testId", value: a["data-testid"] }));
  if (raw.text && raw.text.length <= MAX_TEXT) {
    specs.push(scoped({ kind: "text", text: raw.text, exact: true }));
  }
  specs.push(scoped({ kind: "css", selector: raw.css }));
  return specs;
}

export function toFacts(
  element: Pick<ObservedElement, "role" | "name">,
  raw: RawFacts,
  framePath: LocatorSpec[],
  box: ElementFacts["box"],
): ElementFacts {
  return {
    role: element.role,
    name: element.name,
    tag: raw.tag,
    attributes: raw.attributes,
    text: raw.text,
    anchorText: raw.anchorText,
    framePath,
    box,
  };
}
