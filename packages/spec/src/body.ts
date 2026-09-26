import { isMap, isScalar, LineCounter, type Node, parseDocument, Scalar } from "yaml";
import { parseExactOp } from "./exact.js";
import { NAME } from "./frontmatter.js";
import type { BodyItem, FlowStep, SourceInfo, Step } from "./model.js";
import { parseTemplate } from "./template.js";
import { lineRange, type Reporter, SourceMap } from "./text.js";

/*
 * Body grammar, line by line:
 *   N. text                 a step; indented lines right after it continue it
 *   N. Expect: / Soft: / Never: / Use: / Exact: …   (prefixes are case-insensitive)
 *   Never: text             a guard may also be unnumbered, anywhere
 *   ```ts … ```             a fenced block right after a step line makes it an exact code step
 *   <!-- … -->              a comment (kept when printing)
 *   anything else           TEXT_OUTSIDE_STEPS (kept when printing)
 */

const NUMBERED = /^( {0,3})(\d+)[.)](?=\s|$)[ \t]*(.*)$/;
const GUARD = /^( {0,3})(never\s*:)/i;
const PREFIX = /^(expect|soft|never|use|exact)\s*:[ \t]*/i;
const FENCE = /^(\s*)(`{3,})\s*([A-Za-z]*)\s*$/;
const CODE_LANGS = new Set(["ts", "typescript"]);

const CANONICAL_PREFIX: Record<string, Step["kind"]> = {
  expect: "expect",
  soft: "soft",
  never: "guard",
  use: "flow",
  exact: "exact",
};

interface RawStep {
  number: number | null;
  numberRange: ReturnType<typeof lineRange> | undefined;
  content: string;
  map: SourceMap;
  firstLine: number;
  lastLine: number;
  endColumn: number;
  code?: { lang: string; code: string; langRange: ReturnType<typeof lineRange> };
}

/** Parses the body lines (file lines `firstLine`…). */
export function parseBody(
  lines: readonly string[],
  firstLine: number,
  report: Reporter,
): BodyItem[] {
  const items: BodyItem[] = [];
  let lastNumber = 0;
  let i = 0;
  const lineNo = (index: number) => firstLine + index;

  const collectContinuation = (raw: RawStep) => {
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (line.trim() === "") break;
      const fence = FENCE.exec(line);
      if (fence) {
        collectFence(raw, fence);
        break;
      }
      if (!/^\s/.test(line) || NUMBERED.test(line) || GUARD.test(line)) break;
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      const text = line.trim();
      const offset = raw.content === "" ? 0 : raw.content.length + 1;
      raw.content = raw.content === "" ? text : `${raw.content} ${text}`;
      raw.map.add(offset, lineNo(i), indent + 1);
      raw.lastLine = lineNo(i);
      raw.endColumn = line.trimEnd().length + 1;
      i++;
    }
  };

  const collectFence = (raw: RawStep, open: RegExpExecArray) => {
    const indent = open[1] ?? "";
    const ticks = open[2] ?? "```";
    const lang = open[3] ?? "";
    const openLine = lineNo(i);
    const langRange = lineRange(
      openLine,
      indent.length + ticks.length + 1,
      (lines[i] ?? "").trimEnd().length + 1,
    );
    i++;
    const code: string[] = [];
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (line.trim().startsWith(ticks) && line.trim().replace(/`/g, "") === "") {
        raw.code = { lang, code: code.join("\n"), langRange };
        raw.lastLine = lineNo(i);
        raw.endColumn = line.trimEnd().length + 1;
        i++;
        return;
      }
      code.push(line.startsWith(indent) ? line.slice(indent.length) : line.trimStart());
      i++;
    }
    report.error(
      "FENCE_UNCLOSED",
      lineRange(
        openLine,
        indent.length + 1,
        (lines[openLine - firstLine] ?? "").trimEnd().length + 1,
      ),
      "This code block is never closed.",
      `Close it with a line containing only ${ticks}.`,
    );
    raw.code = { lang, code: code.join("\n"), langRange };
    raw.lastLine = lineNo(lines.length - 1);
    raw.endColumn = (lines[lines.length - 1] ?? "").length + 1;
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const n = lineNo(i);
    if (line.trim() === "") {
      if (items.length > 0 && items[items.length - 1]?.type !== "blank")
        items.push({ type: "blank" });
      i++;
      continue;
    }
    if (line.trimStart().startsWith("<!--")) {
      const start = i;
      while (i < lines.length && !(lines[i] ?? "").includes("-->")) i++;
      const end = Math.min(i, lines.length - 1);
      const text = lines.slice(start, end + 1).join("\n");
      const endPosition = { line: lineNo(end), column: (lines[end] ?? "").length + 1 };
      items.push({
        type: "comment",
        text,
        at: { range: { start: { line: n, column: 1 }, end: endPosition } },
      });
      i = end + 1;
      continue;
    }
    const numbered = NUMBERED.exec(line);
    const guard = numbered ? null : GUARD.exec(line);
    if (numbered || guard) {
      let raw: RawStep;
      if (numbered) {
        const indent = numbered[1]?.length ?? 0;
        const digits = numbered[2] ?? "";
        const content = numbered[3] ?? "";
        const contentColumn = line.length - content.length + 1;
        raw = {
          number: Number(digits),
          numberRange: lineRange(n, indent + 1, indent + digits.length + 2),
          content: content.trimEnd(),
          map: SourceMap.at(n, contentColumn),
          firstLine: n,
          lastLine: n,
          endColumn: line.trimEnd().length + 1,
        };
      } else {
        const indent = guard?.[1]?.length ?? 0;
        raw = {
          number: null,
          numberRange: undefined,
          content: line.trim(),
          map: SourceMap.at(n, indent + 1),
          firstLine: n,
          lastLine: n,
          endColumn: line.trimEnd().length + 1,
        };
      }
      i++;
      const inlineFence = /^(`{3,})\s*([A-Za-z]*)\s*$/.exec(raw.content);
      if (inlineFence) {
        // `N. ```ts` on the step line itself.
        const fence = FENCE.exec(" ".repeat((raw.map.at(0).column ?? 1) - 1) + raw.content);
        raw.content = "";
        i--;
        if (fence) collectFence(raw, fence);
      } else collectContinuation(raw);

      if (raw.number !== null) {
        const expected = lastNumber + 1;
        if (raw.number !== expected) {
          report.warn(
            "STEP_NUMBER_ORDER",
            raw.numberRange,
            `Step ${raw.number} comes after ${lastNumber === 0 ? "the start" : `step ${lastNumber}`}; expected ${expected}.`,
            `Renumber it to ${expected}. (Steps run in file order; the number is only for display.)`,
          );
        }
        lastNumber = raw.number;
      }
      const step = toStep(raw, report);
      if (step) items.push(step);
      else {
        // A step that could not be parsed is kept as text, so printing never loses it.
        const text = lines
          .slice(raw.firstLine - firstLine, raw.lastLine - firstLine + 1)
          .join("\n");
        items.push({ type: "text", text: text.trimEnd(), at: { range: stepRange(raw) } });
      }
      continue;
    }
    report.warn(
      "TEXT_OUTSIDE_STEPS",
      lineRange(n, 1 + (/^\s*/.exec(line)?.[0].length ?? 0), line.trimEnd().length + 1),
      `"${line.trim().slice(0, 60)}" is not a step, so it is ignored.`,
      PREFIX.test(line.trim())
        ? `Number it so it runs, e.g. "${lastNumber + 1}. ${line.trim()}".`
        : 'Make it a numbered step ("1. …"), or turn it into a comment (<!-- … -->).',
    );
    items.push({
      type: "text",
      text: line.trimEnd(),
      at: { range: lineRange(n, 1, line.trimEnd().length + 1) },
    });
    i++;
  }
  while (items[items.length - 1]?.type === "blank") items.pop();
  return items;
}

function stepRange(raw: RawStep) {
  return {
    start: { line: raw.firstLine, column: raw.numberRange?.start.column ?? raw.map.at(0).column },
    end: { line: raw.lastLine, column: raw.endColumn },
  };
}

function toStep(raw: RawStep, report: Reporter): Step | undefined {
  const at = { range: stepRange(raw) };
  const base = { type: "step" as const, number: raw.number, at };

  if (raw.code) {
    if (!CODE_LANGS.has(raw.code.lang.toLowerCase())) {
      report.error(
        "EXACT_CODE_LANG",
        raw.code.langRange,
        raw.code.lang
          ? `Code blocks in tests must be TypeScript, not "${raw.code.lang}".`
          : "This code block has no language.",
        "Start the block with ```ts.",
      );
    }
    const label = raw.content.replace(/^exact\s*:\s*/i, "").trim();
    return {
      ...base,
      kind: "exact",
      exact: { form: "code", lang: "ts", code: raw.code.code, ...(label && { label }) },
    };
  }

  const prefix = PREFIX.exec(raw.content);
  const kind: Step["kind"] = prefix
    ? (CANONICAL_PREFIX[(prefix[1] ?? "").toLowerCase()] ?? "action")
    : "action";
  const offset = prefix ? prefix[0].length : 0;
  const text = raw.content.slice(offset).trim();
  const map = raw.map.from(offset);

  if (text === "") {
    report.error(
      "STEP_EMPTY",
      at.range,
      raw.number === null ? "This step is empty." : `Step ${raw.number} is empty.`,
      prefix
        ? `Write what to ${kind === "flow" ? "include after Use:, e.g. Use: flows/login.test.md" : `check after ${prefix[1]}:`}.`
        : "Write the step, or delete the line.",
    );
    return undefined;
  }

  if (kind === "exact") {
    const op = parseExactOp(text, map, report);
    if (!op) return undefined;
    return { ...base, kind: "exact", exact: { form: "op", op } };
  }
  if (kind === "flow") return parseUse(text, map, base, report);
  return { ...base, kind, text: parseTemplate(text, map, report) };
}

function parseUse(
  text: string,
  map: SourceMap,
  base: { type: "step"; number: number | null; at: SourceInfo },
  report: Reporter,
): FlowStep | undefined {
  const pathMatch = /^\S+/.exec(text);
  const path = pathMatch?.[0] ?? "";
  const pathRange = map.range(0, path.length);
  const rest = text.slice(path.length).trim();
  const restOffset = text.length - rest.length;
  const step: FlowStep = {
    ...base,
    kind: "flow",
    path,
    params: {},
    at: { ...base.at, path: pathRange },
  };
  if (path.startsWith("{")) {
    report.error(
      "USE_SYNTAX",
      pathRange,
      "Use: needs the flow's path before its params.",
      "Write e.g. Use: flows/login.test.md { email: ada@example.com }.",
    );
    return undefined;
  }
  if (rest === "") return step;
  const restMap = map.from(restOffset);
  const restRange = map.range(restOffset, text.length);
  step.at = { range: base.at.range, path: pathRange, params: restRange };
  const lineCounter = new LineCounter();
  const doc = parseDocument(rest, { lineCounter, uniqueKeys: true });
  if (doc.errors.length > 0 || !isMap(doc.contents) || !rest.startsWith("{")) {
    report.error(
      "USE_SYNTAX",
      restRange,
      `"${rest}" is not a params map.`,
      'Write params as an inline map, e.g. { email: "{{data.admin}}", password: "{{secret.ADMIN_PASSWORD}}" }.',
    );
    return undefined;
  }
  for (const pair of doc.contents.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const value = pair.value as Node | null;
    const keyRange = (pair.key as Node | null)?.range;
    const where = keyRange
      ? restMap.range(keyRange[0], value?.range?.[1] ?? keyRange[1])
      : restRange;
    if (!NAME.test(key)) {
      report.error(
        "USE_SYNTAX",
        where,
        `"${key}" is not a valid param name.`,
        "Param names use letters, digits, - and _.",
      );
      continue;
    }
    if (!isScalar(value) || value.value === null || typeof value.value === "object") {
      report.error(
        "USE_SYNTAX",
        where,
        `Param "${key}" needs a single value.`,
        `Write e.g. { ${key}: "some value" }.`,
      );
      continue;
    }
    const quoted = value.type === Scalar.QUOTE_DOUBLE || value.type === Scalar.QUOTE_SINGLE;
    const start = (value.range?.[0] ?? 0) + (quoted ? 1 : 0);
    const valueMap = restMap.from(start);
    step.params[key] = parseTemplate(String(value.value), valueMap, report);
  }
  return step;
}
