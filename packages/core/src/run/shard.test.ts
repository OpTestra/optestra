import { describe, expect, it } from "vitest";
import { parseShard, selectShard } from "./shard.js";

const ids = Array.from(
  { length: 23 },
  (_, i) => `tests__t${String((i * 7) % 23).padStart(2, "0")}`,
);

describe("sharding", () => {
  it("parses i/n and rejects anything else", () => {
    expect(parseShard("2/4")).toEqual({ index: 2, total: 4 });
    expect(parseShard(" 1 / 1 ")).toEqual({ index: 1, total: 1 });
    for (const bad of ["0/4", "5/4", "1/0", "1", "a/b", "1/4/2", "-1/4"])
      expect(typeof parseShard(bad)).toBe("string");
  });

  it("splits into disjoint, complete, balanced slices", () => {
    const slices = [1, 2, 3, 4].map((index) => selectShard(ids, { index, total: 4 }, (id) => id));
    expect(slices.flat().sort()).toEqual([...ids].sort());
    expect(new Set(slices.flat()).size).toBe(ids.length);
    const sizes = slices.map((s) => s.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it("depends only on the ids, not their order", () => {
    const shuffled = [...ids].reverse();
    for (const index of [1, 2, 3])
      expect(selectShard(shuffled, { index, total: 3 }, (id) => id).sort()).toEqual(
        selectShard(ids, { index, total: 3 }, (id) => id).sort(),
      );
  });

  it("keeps the original order inside a slice, and more slices than tests is fine", () => {
    const slice = selectShard(ids, { index: 1, total: 2 }, (id) => id);
    expect(slice).toEqual(ids.filter((id) => slice.includes(id)));
    expect(selectShard(["a"], { index: 3, total: 4 }, (id) => id)).toEqual([]);
  });
});
