import type { Segment, Template } from "./model.js";
import type { Reporter, SourceMap } from "./text.js";

const REF = /^\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_-]*)\s*$/;

/**
 * Splits text into literal text and `{{ns.name}}` references. Spacing inside
 * the braces is allowed (`{{ data.x }}`). `\{{` is a literal `{{`. Syntax
 * problems are reported; checking that a reference exists is done later (refs.ts).
 */
export function parseTemplate(raw: string, map?: SourceMap, report?: Reporter): Template {
  const segments: Segment[] = [];
  let text = "";
  const flush = () => {
    if (text !== "") segments.push({ kind: "text", text });
    text = "";
  };
  let i = 0;
  while (i < raw.length) {
    if (raw.startsWith("\\{{", i)) {
      text += "{{";
      i += 3;
      continue;
    }
    if (!raw.startsWith("{{", i)) {
      text += raw[i];
      i++;
      continue;
    }
    const close = raw.indexOf("}}", i + 2);
    const nextOpen = raw.indexOf("{{", i + 2);
    if (close < 0 || (nextOpen >= 0 && nextOpen < close)) {
      const end = nextOpen >= 0 && (close < 0 || nextOpen < close) ? nextOpen : raw.length;
      report?.error(
        "TEMPLATE_UNCLOSED",
        map?.range(i, end),
        `"{{" at "${raw.slice(i, Math.min(end, i + 30))}" is never closed with "}}".`,
        `Close the variable with "}}", e.g. {{data.email}}, or write \\{{ for literal braces.`,
      );
      text += raw.slice(i, end);
      i = end;
      continue;
    }
    const inner = raw.slice(i + 2, close);
    const refText = raw.slice(i, close + 2);
    const match = REF.exec(inner);
    if (!match) {
      report?.error(
        "TEMPLATE_SYNTAX",
        map?.range(i, close + 2),
        `"${refText}" is not a variable reference; expected {{namespace.name}}.`,
        `Write the variable as {{data.name}}, {{env.NAME}}, {{secret.NAME}}, {{params.name}}, {{unique.email}} or {{faker.name}}.`,
      );
      text += refText;
    } else {
      flush();
      segments.push({
        kind: "var",
        ns: match[1] ?? "",
        name: match[2] ?? "",
        raw: refText,
        ...(map && { at: { range: map.range(i, close + 2) } }),
      });
    }
    i = close + 2;
  }
  flush();
  return { raw, segments, ...(map && { at: { range: map.whole(raw.length) } }) };
}

/** The references in a template. */
export function templateRefs(template: Template) {
  return template.segments.filter((s): s is Extract<Segment, { kind: "var" }> => s.kind === "var");
}

/** A template with no source positions, e.g. for text an editor builds. */
export function template(raw: string): Template {
  return parseTemplate(raw);
}
