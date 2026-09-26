import { clone, formatPath, isPlainObject, type Path } from "./paths.js";

/** Where a resolved value came from, lowest to highest precedence. */
export type ConfigSource = "default" | "project" | "environment" | "envVar" | "runOption";

export const SOURCE_ORDER: readonly ConfigSource[] = [
  "default",
  "project",
  "environment",
  "envVar",
  "runOption",
];

export interface Provenance {
  source: ConfigSource;
  /** Project file, for `project` and `environment`. */
  file?: string;
  /** 1-based line in `file`. */
  line?: number;
  /** Environment whose overrides set the value. */
  environment?: string;
  /** Environment variable that set the value. */
  envVar?: string;
  /** Extra detail, e.g. "host of baseUrl". */
  note?: string;
}

/** Provenance fields other than `source`; undefined fields are dropped. */
export type ProvenanceDetails = {
  [K in Exclude<keyof Provenance, "source">]?: Provenance[K] | undefined;
};

export interface Layer {
  source: ConfigSource;
  value: unknown;
  /** Location details for a path inside this layer. */
  describe?: (path: Path) => ProvenanceDetails;
}

export type ProvenanceMap = Map<string, Provenance>;

function clearUnder(provenance: ProvenanceMap, path: Path): void {
  const key = formatPath(path);
  for (const existing of [...provenance.keys()]) {
    if (existing === key || existing.startsWith(`${key}.`) || existing.startsWith(`${key}[`)) {
      provenance.delete(existing);
    }
  }
}

export function withoutUndefined(details: ProvenanceDetails): Omit<Provenance, "source"> {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}

/**
 * Deep-merges layers in order (later wins) and records the provenance of every
 * leaf. Objects merge key by key; arrays and plain values replace; null and
 * undefined mean "not set" and are skipped.
 */
export function mergeLayers(layers: readonly Layer[]): {
  value: Record<string, unknown>;
  provenance: ProvenanceMap;
} {
  const value: Record<string, unknown> = {};
  const provenance: ProvenanceMap = new Map();

  const record = (layer: Layer, path: Path) => {
    provenance.set(formatPath(path), {
      source: layer.source,
      ...withoutUndefined(layer.describe?.(path) ?? {}),
    });
  };

  const mergeInto = (
    target: Record<string, unknown>,
    source: Record<string, unknown>,
    path: Path,
    layer: Layer,
  ) => {
    for (const [key, next] of Object.entries(source)) {
      if (next === null || next === undefined) continue;
      const at = [...path, key];
      if (isPlainObject(next)) {
        if (!isPlainObject(target[key])) {
          clearUnder(provenance, at);
          target[key] = {};
        }
        const child = target[key] as Record<string, unknown>;
        if (Object.keys(next).length > 0) provenance.delete(formatPath(at));
        mergeInto(child, next, at, layer);
        if (Object.keys(child).length === 0) record(layer, at);
      } else {
        clearUnder(provenance, at);
        target[key] = clone(next);
        record(layer, at);
      }
    }
  };

  for (const layer of layers) {
    if (isPlainObject(layer.value)) mergeInto(value, layer.value, [], layer);
  }
  return { value, provenance };
}

/** Provenance of `path`, or of its closest ancestor that has one. */
export function provenanceOf(provenance: ProvenanceMap, path: Path): Provenance | undefined {
  for (let length = path.length; length > 0; length--) {
    const found = provenance.get(formatPath(path.slice(0, length)));
    if (found) return found;
  }
  return undefined;
}
