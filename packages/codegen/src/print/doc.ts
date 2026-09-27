// A small, deterministic document printer in the style of Prettier's (which
// Biome follows): groups print on one line when they fit in the line width and
// break otherwise. Only the pieces the spec generator needs are here.

export type Doc =
  | string
  | Doc[]
  | { kind: "group"; contents: Doc; break: boolean; states?: Doc[] }
  | { kind: "indent"; contents: Doc }
  | { kind: "line"; soft: boolean; hard: boolean }
  | { kind: "ifBreak"; broken: Doc; flat: Doc }
  | { kind: "breakParent" };

export const line: Doc = { kind: "line", soft: false, hard: false };
export const softline: Doc = { kind: "line", soft: true, hard: false };
export const hardline: Doc = [{ kind: "line", soft: false, hard: true }, { kind: "breakParent" }];
export const breakParent: Doc = { kind: "breakParent" };

export function group(contents: Doc, options: { shouldBreak?: boolean } = {}): Doc {
  return { kind: "group", contents, break: options.shouldBreak ?? false };
}

/** Tries each state in order: the first that fits wins, else the last one. */
export function conditionalGroup(states: Doc[], options: { shouldBreak?: boolean } = {}): Doc {
  return {
    kind: "group",
    contents: states[0] ?? "",
    break: options.shouldBreak ?? false,
    states,
  };
}

export function indent(contents: Doc): Doc {
  return { kind: "indent", contents };
}

export function ifBreak(broken: Doc, flat: Doc = ""): Doc {
  return { kind: "ifBreak", broken, flat };
}

export function join(separator: Doc, docs: readonly Doc[]): Doc {
  const out: Doc[] = [];
  docs.forEach((doc, index) => {
    if (index > 0) out.push(separator);
    out.push(doc);
  });
  return out;
}

/** True when printing `doc` always produces a line break. */
export function willBreak(doc: Doc): boolean {
  if (typeof doc === "string") return false;
  if (Array.isArray(doc)) return doc.some(willBreak);
  switch (doc.kind) {
    case "group":
      return doc.break || willBreak(doc.contents);
    case "indent":
      return willBreak(doc.contents);
    case "line":
      return doc.hard;
    case "ifBreak":
      return willBreak(doc.broken);
    case "breakParent":
      return true;
  }
}

/** Marks every group that contains a hard break as broken (conditional groups excepted). */
function propagateBreaks(doc: Doc): boolean {
  if (typeof doc === "string") return false;
  if (Array.isArray(doc)) {
    let found = false;
    for (const part of doc) found = propagateBreaks(part) || found;
    return found;
  }
  switch (doc.kind) {
    case "group": {
      let found = propagateBreaks(doc.contents);
      for (const state of doc.states?.slice(1) ?? []) propagateBreaks(state);
      if (found && !doc.states) doc.break = true;
      if (doc.break) found = true;
      return found;
    }
    case "indent":
      return propagateBreaks(doc.contents);
    case "line":
      return doc.hard;
    case "ifBreak":
      return propagateBreaks(doc.broken) || propagateBreaks(doc.flat);
    case "breakParent":
      return true;
  }
}

type Mode = "flat" | "break";
type Command = [indent: number, mode: Mode, doc: Doc];

/** Whether `next` fits in `width` columns, looking at the rest up to the first line break. */
function fits(next: Command, rest: Command[], width: number, mustBeFlat: boolean): boolean {
  const stack: Command[] = [next];
  let remaining = width;
  let restIndex = rest.length;
  while (remaining >= 0) {
    let command = stack.pop();
    if (!command) {
      if (restIndex === 0) return true;
      command = rest[--restIndex] as Command;
    }
    const [ind, mode, doc] = command;
    if (typeof doc === "string") {
      remaining -= doc.length;
      continue;
    }
    if (Array.isArray(doc)) {
      for (let i = doc.length - 1; i >= 0; i--) stack.push([ind, mode, doc[i] as Doc]);
      continue;
    }
    switch (doc.kind) {
      case "group": {
        if (mustBeFlat && doc.break) return false;
        const groupMode: Mode = doc.break ? "break" : mode;
        const contents =
          doc.states && groupMode === "break" ? (doc.states.at(-1) ?? "") : doc.contents;
        stack.push([ind, groupMode, contents]);
        break;
      }
      case "indent":
        stack.push([ind, mode, doc.contents]);
        break;
      case "ifBreak":
        stack.push([ind, mode, mode === "break" ? doc.broken : doc.flat]);
        break;
      case "line":
        if (mode === "break" || doc.hard) return true;
        if (!doc.soft) remaining -= 1;
        break;
      case "breakParent":
        break;
    }
  }
  return false;
}

/** Prints a document with 2-space indentation, trimming trailing spaces. */
export function printDoc(doc: Doc, width = 100): string {
  propagateBreaks(doc);
  const out: string[] = [];
  let column = 0;
  let remeasure = false;
  const commands: Command[] = [[0, "break", doc]];
  while (commands.length > 0) {
    const [ind, mode, current] = commands.pop() as Command;
    if (typeof current === "string") {
      out.push(current);
      column += current.length;
      continue;
    }
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) commands.push([ind, mode, current[i] as Doc]);
      continue;
    }
    switch (current.kind) {
      case "group": {
        if (mode === "flat" && !remeasure) {
          commands.push([ind, current.break ? "break" : "flat", current.contents]);
          break;
        }
        remeasure = false;
        const next: Command = [ind, "flat", current.contents];
        if (!current.break && fits(next, commands, width - column, false)) {
          commands.push(next);
          break;
        }
        if (current.states) {
          const mostExpanded = current.states.at(-1) ?? "";
          if (current.break) {
            commands.push([ind, "break", mostExpanded]);
            break;
          }
          let chosen: Command = [ind, "break", mostExpanded];
          for (let i = 1; i < current.states.length; i++) {
            const state: Command = [ind, "flat", current.states[i] as Doc];
            if (fits(state, commands, width - column, false)) {
              chosen = state;
              break;
            }
          }
          commands.push(chosen);
          break;
        }
        commands.push([ind, "break", current.contents]);
        break;
      }
      case "indent":
        commands.push([ind + 2, mode, current.contents]);
        break;
      case "ifBreak":
        commands.push([ind, mode, mode === "break" ? current.broken : current.flat]);
        break;
      case "line":
        if (mode === "flat" && !current.hard) {
          if (!current.soft) {
            out.push(" ");
            column += 1;
          }
          break;
        }
        // After a hard break inside a flat group, the groups that follow are
        // measured again (as Prettier does), so long lines in callbacks wrap.
        if (mode === "flat") remeasure = true;
        while (out.length > 0 && / +$/.test(out[out.length - 1] as string)) {
          out[out.length - 1] = (out[out.length - 1] as string).replace(/ +$/, "");
          if (out[out.length - 1] === "") out.pop();
          else break;
        }
        out.push(`\n${" ".repeat(ind)}`);
        column = ind;
        break;
      case "breakParent":
        break;
    }
  }
  return out
    .join("")
    .split("\n")
    .map((text) => text.replace(/[ \t]+$/, ""))
    .join("\n");
}
