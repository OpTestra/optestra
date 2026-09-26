import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brand } from "@testament/brand";
import { Redactor } from "@testament/config/node";
import { afterAll, describe, expect, it } from "vitest";
import { createDecisions, mockBackend, pageIsError } from "../index.js";
import { createLabelStore, fileCache } from "./index.js";

const dirs: string[] = [];
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "decide-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const unclear = { status: 403, title: "Acme", heading: "", text: "Please sign in." };

describe("fileCache", () => {
  it("stores model answers under the data dir and serves them to a new instance", async () => {
    const dir = project();
    const backend = mockBackend({
      respond: () => ({
        ok: true,
        answers: { is_error: { kind: "noul", value: false, confidence: 0.9 } },
      }),
    });
    const first = createDecisions({ backend, cache: fileCache(dir) });
    await first.decide("page_is_error", unclear);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cacheDir = join(dir, brand.dataDirName, "decisions");
    expect(readdirSync(cacheDir).filter((f) => f.endsWith(".json"))).toHaveLength(1);

    const second = createDecisions({ backend, cache: fileCache(dir) });
    expect(await second.decide("page_is_error", unclear)).toMatchObject({
      status: "decided",
      cached: true,
    });
    expect(backend.calls).toHaveLength(1);
  });

  it("treats a corrupt entry as a miss", async () => {
    const dir = project();
    const cache = fileCache(dir);
    await cache.set("k", { answers: { a: true }, confidence: 1, source: "x", storedAt: 1 });
    const [file] = readdirSync(cache.dir);
    writeFileSync(join(cache.dir, file ?? ""), "{not json");
    expect(await cache.get("k")).toBeUndefined();
    expect(await cache.get("other")).toBeUndefined();
  });
});

describe("label store", () => {
  it("appends labelled examples and scrubs a planted secret", () => {
    const dir = project();
    const redactor = new Redactor();
    redactor.register("hunter2-secret-token", "[secret:API_TOKEN]");
    const store = createLabelStore(dir, { scrub: (t) => redactor.redact(t) });
    const input = {
      status: 500,
      title: "Error",
      heading: "Server error",
      text: "token=hunter2-secret-token",
    };
    store.recordLabel(pageIsError, input, { is_error: true }, { source: "confirmed" });
    store.recordLabel(
      pageIsError,
      { ...input, status: 200 },
      { is_error: false },
      { source: "rejected" },
    );

    const file = join(dir, brand.dataDirName, "labels", "page_is_error.jsonl");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("hunter2-secret-token");
    expect(text).toContain("[secret:API_TOKEN]");
    const labels = store.readLabels("page_is_error");
    expect(labels.map((l) => [l.source, l.answers.is_error, l.version])).toEqual([
      ["confirmed", true, 1],
      ["rejected", false, 1],
    ]);
  });

  it("uses the process-wide redactor by default and rejects answers that don't fit", () => {
    const dir = project();
    const store = createLabelStore(dir);
    expect(() =>
      store.recordLabel(pageIsError, unclear, { is_error: "yes" as never }, { source: "approved" }),
    ).toThrow(/does not fit/);
    expect(existsSync(join(dir, brand.dataDirName, "labels"))).toBe(false);
    expect(store.readLabels("../etc")).toEqual([]);
  });
});
