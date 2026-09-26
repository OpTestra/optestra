export type Path = readonly string[];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `["environments", "eu.west", "baseUrl"]` → `environments["eu.west"].baseUrl`. */
export function formatPath(path: Path): string {
  return path.reduce((out, segment) => {
    if (/^[A-Za-z_$][\w$-]*$/.test(segment)) return out === "" ? segment : `${out}.${segment}`;
    return `${out}[${JSON.stringify(segment)}]`;
  }, "");
}

export function getAt(value: unknown, path: Path): unknown {
  let current = value;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function setAt(target: Record<string, unknown>, path: Path, value: unknown): void {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    if (!isPlainObject(current[segment])) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  const last = path.at(-1);
  if (last !== undefined) current[last] = value;
}

export function deleteAt(target: Record<string, unknown>, path: Path): void {
  const parent = getAt(target, path.slice(0, -1));
  const last = path.at(-1);
  if (isPlainObject(parent) && last !== undefined) delete parent[last];
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Deep merge for plain objects; arrays and plain values in `over` replace. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined || over === null) return clone(base);
  if (!isPlainObject(base) || !isPlainObject(over)) return clone(over);
  const out: Record<string, unknown> = clone(base);
  for (const [key, value] of Object.entries(over)) out[key] = deepMerge(out[key], value);
  return out;
}
