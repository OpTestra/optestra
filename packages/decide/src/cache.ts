/** A backend answer kept for reuse. Rules answers are never cached (they're instant). */
export interface CachedDecision {
  answers: Record<string, unknown>;
  confidence: number;
  /** The backend id that answered. */
  source: string;
  /** Epoch milliseconds when it was stored. */
  storedAt: number;
}

/**
 * Content-addressed decision store. `key` is `cacheKey(...)`; stores may hash
 * it further (the file store uses sha256 for the file name).
 */
export interface DecisionCache {
  get(key: string): Promise<CachedDecision | undefined>;
  set(key: string, value: CachedDecision): Promise<void>;
}

/** JSON with object keys sorted at every level, so equal inputs give equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

/** The cache key: task name + version + normalized (parsed, key-sorted) input + backend id. */
export function cacheKey(task: string, version: number, input: unknown, backend: string): string {
  return canonicalJson(["d1", task, version, backend, input]);
}

/** In-memory cache (tests, the cloud worker's per-run cache). */
export function memoryCache(): DecisionCache & { readonly size: number } {
  const entries = new Map<string, CachedDecision>();
  return {
    get size() {
      return entries.size;
    },
    async get(key) {
      return entries.get(key);
    },
    async set(key, value) {
      entries.set(key, value);
    },
  };
}
