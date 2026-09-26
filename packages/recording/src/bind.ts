import type { CheckOp } from "./schema.js";
import { templateParts } from "./templates.js";

// Check values are templates (REP-7). Before a check runs, its references are
// bound to this run's values. Secrets are never check values: a check that
// references one is refused, never evaluated.

export type BoundCheck =
  | { ok: true; op: CheckOp }
  | { ok: false; reason: "secret" | "unresolved"; message: string };

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function bind(
  template: string,
  values: Readonly<Record<string, string>>,
  regex: boolean,
): { ok: true; text: string } | { ok: false; reason: "secret" | "unresolved"; message: string } {
  let text = "";
  for (const part of templateParts(template, values)) {
    if ("secret" in part) {
      return {
        ok: false,
        reason: "secret",
        message: `A check can't use a secret ({{secret.${part.secret}}}): secrets are never check values.`,
      };
    }
    if ("unresolved" in part) {
      return {
        ok: false,
        reason: "unresolved",
        message: `{{${part.unresolved}}} has no value here.`,
      };
    }
    text += part.text;
  }
  // Literal regex text keeps its meaning; only substituted values are escaped.
  if (regex && template.includes("{{")) {
    let out = "";
    let last = 0;
    for (const match of template.matchAll(/(?<!\\)\{\{\s*([a-zA-Z]+\.[A-Za-z0-9_.-]+)\s*\}\}/g)) {
      out += template.slice(last, match.index).replace(/\\\{\{/g, "{{");
      out += escapeRegex(values[match[1] as string] ?? "");
      last = (match.index ?? 0) + match[0].length;
    }
    return { ok: true, text: out + template.slice(last).replace(/\\\{\{/g, "{{") };
  }
  return { ok: true, text };
}

/** The op with every template bound to `values`. Refuses secrets and unresolved references. */
export function bindCheck(op: CheckOp, values: Readonly<Record<string, string>> = {}): BoundCheck {
  switch (op.type) {
    case "text":
    case "url":
    case "value": {
      const bound = bind(op.value, values, op.match === "matches");
      return bound.ok ? { ok: true, op: { ...op, value: bound.text } as CheckOp } : bound;
    }
    case "network": {
      const bound = bind(op.url, values, false);
      return bound.ok ? { ok: true, op: { ...op, url: bound.text } } : bound;
    }
    default:
      return { ok: true, op };
  }
}
