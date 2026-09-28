import type { ObservedElement } from "@testament/browser";

// How a drafted action reads in the test (AUT-7). Written by code from the
// element the action used, never by the model, so a draft's steps name what the
// user sees ("Click "Log in"") and lint clean: the model can't write a vague step.

/** The element's visible label: its accessible name, else its text. */
export function labelOf(element: ObservedElement | undefined): string | undefined {
  const label = (element?.name || element?.text || "").replace(/\s+/g, " ").trim();
  if (!label) return undefined;
  // A double quote would end the quoted label early; the page's own quotes become single ones.
  return label.replace(/["“”]/g, "'").slice(0, 80);
}

const quoted = (label: string) => `"${label}"`;

/** `"Name"`, or the role when the element has no label ("the checkbox"). */
function target(element: ObservedElement | undefined): string {
  const label = labelOf(element);
  if (label) return quoted(label);
  return `the ${element?.role ?? "element"}`;
}

export type DraftedAction =
  | { type: "click" | "dblclick" | "check" | "uncheck" | "hover"; element: ObservedElement }
  | { type: "fill"; element: ObservedElement; value: string }
  | { type: "select"; element: ObservedElement; option: string }
  | { type: "press"; key: string; element?: ObservedElement | undefined }
  | { type: "upload"; element: ObservedElement; file: string }
  | { type: "goto"; url: string }
  | { type: "back" | "reload" };

/** The step line (without its number) for an action; values as templates. */
export function stepText(action: DraftedAction): string {
  switch (action.type) {
    case "click":
      return `Click ${target(action.element)}`;
    case "dblclick":
      return `Double-click ${target(action.element)}`;
    case "check":
      return `Check ${target(action.element)}`;
    case "uncheck":
      return `Uncheck ${target(action.element)}`;
    case "hover":
      return `Hover over ${target(action.element)}`;
    case "fill":
      return `Fill ${target(action.element)} with ${action.value}`;
    case "select":
      return `Select ${quoted(action.option)} in ${target(action.element)}`;
    case "press":
      return `Press ${action.key}${action.element ? ` in ${target(action.element)}` : ""}`;
    case "upload":
      return `Upload ${action.file} to ${target(action.element)}`;
    case "goto":
      return `Go to ${action.url}`;
    case "back":
      return "Go back";
    case "reload":
      return "Reload the page";
  }
}

/** A file name for a test name: lowercase words joined by "-". */
export function slugOf(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-");
  return slug || "draft";
}

/** A test name from the sentence, when the model gave none. */
export function nameFromSentence(sentence: string): string {
  const text = sentence
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Draft test";
}
