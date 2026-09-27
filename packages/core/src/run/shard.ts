// Sharding across machines (CLI-3, CI-6): `--shard 2/4` runs the second of four
// slices. The split depends only on the selected test ids: they are sorted and
// dealt out in turn, so every machine computes the same slices from the same
// checkout, the slices never overlap, together they are the whole selection, and
// their sizes differ by at most one.

export interface Shard {
  /** 1-based. */
  index: number;
  total: number;
}

/** Parses "i/n" (1 ≤ i ≤ n). Returns a message for anything else. */
export function parseShard(text: string): Shard | string {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || total < 1 || index < 1 || index > total)
    return `--shard must look like 1/4 (this machine's slice / number of slices), not "${text}".`;
  return { index, total };
}

/** The items in this shard, in their original order. */
export function selectShard<T>(items: readonly T[], shard: Shard, idOf: (item: T) => string): T[] {
  if (shard.total === 1) return [...items];
  const ids = [...new Set(items.map(idOf))].sort();
  const mine = new Set(ids.filter((_, position) => position % shard.total === shard.index - 1));
  return items.filter((item) => mine.has(idOf(item)));
}
