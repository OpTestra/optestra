/**
 * Minimal glob matching for `tests.include`: `**` (any folders), `*` (within a
 * name), `?` and `{a,b}`. Paths are `/`-separated and relative. Deterministic
 * and browser-safe, so the web app lists cloud files the same way.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  let braces = 0;
  while (i < glob.length) {
    const ch = glob[i] ?? "";
    if (glob.startsWith("**/", i)) {
      out += "(?:[^/]+/)*";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (ch === "*") {
      out += "[^/]*";
      i++;
    } else if (ch === "?") {
      out += "[^/]";
      i++;
    } else if (ch === "{") {
      out += "(?:";
      braces++;
      i++;
    } else if (ch === "}" && braces > 0) {
      out += ")";
      braces--;
      i++;
    } else if (ch === "," && braces > 0) {
      out += "|";
      i++;
    } else {
      out += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${out}${")".repeat(braces)}$`);
}

export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

export function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => matchGlob(glob, path));
}
