// Values in recordings are templates (REP-7): literal text plus `{{ns.name}}`
// references, `{{secret.NAME}}` for secrets. One recording then works for many
// test users. A literal `{{` is written `\{{` (same rule as test files).

/** A variable the step can use: its reference and (for non-secrets) its value. */
export interface TemplateVariable {
  /** e.g. "data.email", "params.password", "secret.SHOP_PASSWORD". */
  ref: string;
  /** The bound value; undefined for secrets and unresolved references. */
  value?: string;
}

const REF = /\{\{\s*([a-zA-Z]+\.[A-Za-z0-9_.-]+)\s*\}\}/g;
const MIN_VALUE_LENGTH = 3;

/**
 * Turns what the agent typed into a template: known `{{refs}}` are kept, values
 * equal to a variable's value become its reference, other `{{` are escaped.
 */
export function toTemplate(typed: string, variables: readonly TemplateVariable[]): string {
  const known = new Set(variables.map((v) => v.ref));
  const values = variables
    .filter(
      (v): v is Required<TemplateVariable> =>
        v.value !== undefined && v.value.length >= MIN_VALUE_LENGTH && !v.ref.startsWith("secret."),
    )
    .sort((a, b) => b.value.length - a.value.length);
  let out = "";
  let last = 0;
  const literal = (text: string) => {
    let escaped = text.replace(/(?<!\\)\{\{/g, "\\{{");
    for (const variable of values)
      escaped = escaped.split(variable.value).join(`{{${variable.ref}}}`);
    return escaped;
  };
  for (const match of typed.matchAll(REF)) {
    const ref = match[1] as string;
    if (!known.has(ref)) continue;
    out += literal(typed.slice(last, match.index)) + `{{${ref}}}`;
    last = (match.index ?? 0) + match[0].length;
  }
  return out + literal(typed.slice(last));
}

export type ResolvedPart = { text: string } | { secret: string } | { unresolved: string };

/** Splits a template into literal text, secret references and other references. */
export function templateParts(
  template: string,
  values: Readonly<Record<string, string>>,
): ResolvedPart[] {
  const parts: ResolvedPart[] = [];
  let text = "";
  let last = 0;
  for (const match of template.matchAll(REF)) {
    const start = match.index ?? 0;
    if (start > 0 && template[start - 1] === "\\") continue;
    text += template.slice(last, start);
    last = start + match[0].length;
    const ref = match[1] as string;
    if (ref.startsWith("secret.")) {
      if (text) parts.push({ text });
      text = "";
      parts.push({ secret: ref.slice("secret.".length) });
    } else if (values[ref] !== undefined) {
      text += values[ref];
    } else {
      if (text) parts.push({ text });
      text = "";
      parts.push({ unresolved: ref });
    }
  }
  text += template.slice(last);
  if (text) parts.push({ text: text.replace(/\\\{\{/g, "{{") });
  return parts.map((part) =>
    "text" in part ? { text: part.text.replace(/\\\{\{/g, "{{") } : part,
  );
}

/** References used by a template, in order. */
export function templateRefs(template: string): string[] {
  return [...template.matchAll(REF)]
    .filter((m) => !(m.index && template[m.index - 1] === "\\"))
    .map((m) => m[1] as string);
}
