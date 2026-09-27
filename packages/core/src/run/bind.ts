import type { Action, LocatorSpec } from "@testament/browser";
import { type Locator, type RecordedAction, templateParts } from "@testament/recording";
import { harnessValue, type StepVariables } from "../author/variables.js";

// Binding a recorded command for this run (REP-7): templates get this run's
// values (data, params, env, generated unique/faker values); secrets stay
// references that only the harness turns into values (SEC-1).

export type BoundAction =
  | { ok: true; action: Action }
  | { ok: false; reason: "unresolved" | "secret"; message: string };

const asSpec = (locator: Locator): LocatorSpec => locator as LocatorSpec;

/** A template with no secret in it, bound to text. */
function text(
  template: string,
  variables: StepVariables,
): { ok: true; text: string } | { ok: false; reason: "unresolved" | "secret"; message: string } {
  let out = "";
  for (const part of templateParts(template, variables.values)) {
    if ("secret" in part)
      return {
        ok: false,
        reason: "secret",
        message: `{{secret.${part.secret}}} can only be typed into a field, on its own.`,
      };
    if ("unresolved" in part)
      return {
        ok: false,
        reason: "unresolved",
        message: `{{${part.unresolved}}} has no value in this run.`,
      };
    out += part.text;
  }
  return { ok: true, text: out };
}

/** The harness action for a recorded one, with this run's values. */
export function bindAction(recorded: RecordedAction, variables: StepVariables): BoundAction {
  switch (recorded.type) {
    case "goto": {
      const url = text(recorded.url, variables);
      return url.ok ? { ok: true, action: { type: "goto", url: url.text } } : url;
    }
    case "fill": {
      const value = harnessValue(recorded.value, variables);
      if (!value.ok)
        return {
          ok: false,
          reason: /secret/i.test(value.error) ? "secret" : "unresolved",
          message: value.error,
        };
      return {
        ok: true,
        action: { type: "fill", target: asSpec(recorded.target), value: value.value },
      };
    }
    case "select": {
      const options = typeof recorded.option === "string" ? [recorded.option] : recorded.option;
      const bound: string[] = [];
      for (const option of options) {
        const one = text(option, variables);
        if (!one.ok) return one;
        bound.push(one.text);
      }
      return {
        ok: true,
        action: {
          type: "select",
          target: asSpec(recorded.target),
          option: typeof recorded.option === "string" ? (bound[0] ?? "") : bound,
        },
      };
    }
    case "waitFor": {
      let bound: string | undefined;
      if (recorded.text !== undefined) {
        const one = text(recorded.text, variables);
        if (!one.ok) return one;
        bound = one.text;
      }
      return {
        ok: true,
        action: {
          type: "waitFor",
          ...(bound !== undefined ? { text: bound } : {}),
          ...(recorded.target ? { target: asSpec(recorded.target) } : {}),
          ...(recorded.timeoutMs !== undefined ? { timeoutMs: recorded.timeoutMs } : {}),
        },
      };
    }
    case "press":
      return {
        ok: true,
        action: {
          type: "press",
          key: recorded.key,
          ...(recorded.target ? { target: asSpec(recorded.target) } : {}),
        },
      };
    case "scroll":
      return {
        ok: true,
        action: {
          type: "scroll",
          ...(recorded.target ? { target: asSpec(recorded.target) } : {}),
          ...(recorded.direction ? { direction: recorded.direction } : {}),
          ...(recorded.pixels !== undefined ? { pixels: recorded.pixels } : {}),
        },
      };
    case "upload":
      return {
        ok: true,
        action: { type: "upload", target: asSpec(recorded.target), files: recorded.files },
      };
    case "click":
    case "dblclick":
    case "check":
    case "uncheck":
    case "hover":
      return { ok: true, action: { type: recorded.type, target: asSpec(recorded.target) } };
    case "back":
    case "reload":
      return { ok: true, action: { type: recorded.type } };
  }
}

/** The action's element target, if it has one. */
export function targetOf(action: RecordedAction): Locator | undefined {
  return "target" in action ? action.target : undefined;
}

/** The same action aimed at another element (a heal: only how the step is done changes). */
export function retarget(action: Action, target: Locator): Action {
  if (!("target" in action) || action.target === undefined) return action;
  return { ...action, target: asSpec(target) } as Action;
}

/** The recorded action aimed at another element, for the recording diff. */
export function retargetRecorded(action: RecordedAction, target: Locator): RecordedAction {
  if (!("target" in action) || action.target === undefined) return action;
  return { ...action, target } as RecordedAction;
}
