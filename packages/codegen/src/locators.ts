import type { FrameLocator, Locator } from "@optestra/recording";
import { type Expr, id, method, num, obj, raw, str } from "./print/js.js";

// Recorded locators → Playwright locators, mirroring `@optestra/browser`'s
// `toLocator`: text-like locators match exactly unless recorded otherwise,
// iframes are entered through their frame path, `nth` picks one of several.

type Spec = Locator | FrameLocator;

function exactOption(spec: Spec): Array<[string, Expr]> {
  const exact = "exact" in spec ? (spec.exact ?? true) : true;
  return exact ? [["exact", raw("true")]] : [];
}

function within(scope: Expr, spec: Spec): Expr {
  switch (spec.kind) {
    case "role": {
      // A heading level (checks: "the page heading" is the h1) narrows it like the harness does.
      const level: Array<[string, Expr]> =
        "level" in spec && spec.level !== undefined ? [["level", num(spec.level)]] : [];
      if (spec.name === undefined)
        return level.length > 0
          ? method(scope, "getByRole", str(spec.role), obj(level))
          : method(scope, "getByRole", str(spec.role));
      return method(
        scope,
        "getByRole",
        str(spec.role),
        obj([["name", str(spec.name)], ...exactOption(spec), ...level]),
      );
    }
    case "label":
    case "placeholder":
    case "alt":
    case "title":
    case "text": {
      const name = {
        label: "getByLabel",
        placeholder: "getByPlaceholder",
        alt: "getByAltText",
        title: "getByTitle",
        text: "getByText",
      }[spec.kind];
      const options = exactOption(spec);
      return options.length > 0
        ? method(scope, name, str(spec.text), obj(options))
        : method(scope, name, str(spec.text));
    }
    case "testId":
      return method(scope, "getByTestId", str(spec.value));
    case "css":
      return method(scope, "locator", str(spec.selector));
  }
}

function pick(locator: Expr, nth: number | undefined): Expr {
  if (nth === undefined) return locator;
  return nth === 0 ? method(locator, "first") : method(locator, "nth", num(nth));
}

/** The frame an element lives in: `page`, or a frame locator reached through the frame path. */
export function frameScope(root: Expr, frames: readonly FrameLocator[] | undefined): Expr {
  let scope = root;
  for (const frame of frames ?? []) {
    scope =
      frame.kind === "css" && frame.nth === undefined
        ? method(scope, "frameLocator", str(frame.selector))
        : method(pick(within(scope, frame), frame.nth), "contentFrame");
  }
  return scope;
}

/** A Playwright locator for a recorded locator, optionally inside a container (`scope`). */
export function locatorExpr(target: Locator, container?: Locator): Expr {
  const page = id("page");
  if (container) {
    const outer = pick(within(frameScope(page, container.frame), container), container.nth);
    return pick(within(frameScope(outer, target.frame), target), target.nth);
  }
  return pick(within(frameScope(page, target.frame), target), target.nth);
}

/** Roles whose element carries a value rather than text (text checks read the value). */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);

/** True when a text check on this target should compare the field's value. */
export function holdsValue(target: Locator): boolean {
  return (
    target.kind === "label" ||
    target.kind === "placeholder" ||
    (target.kind === "role" && VALUE_ROLES.has(target.role))
  );
}
