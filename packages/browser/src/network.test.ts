import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Mocks, Traffic } from "./network.js";

// ENV-4: which requests a mock answers, and what recorded traffic keeps.

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("Mocks", () => {
  it("matches the method and the URL pattern; * is anything; no ? means any query; latest wins", () => {
    const mocks = new Mocks();
    mocks.add({ method: "GET", url: "http://shop.test/api/orders", status: 500 });
    mocks.add({ method: "GET", url: "http://shop.test/api/orders/*", status: 404, stepIndex: 3 });
    expect(mocks.match("GET", "http://shop.test/api/orders?page=2")?.status).toBe(500);
    expect(mocks.match("GET", "http://shop.test/api/orders/17")?.status).toBe(404);
    expect(mocks.match("POST", "http://shop.test/api/orders")).toBeUndefined();
    expect(mocks.match("GET", "http://shop.test/api/ordersX")).toBeUndefined();
    mocks.add({ method: "GET", url: "http://shop.test/api/orders", status: 503 });
    expect(mocks.match("GET", "http://shop.test/api/orders")?.status).toBe(503);
    expect(mocks.uses()).toEqual([
      {
        source: "step",
        method: "GET",
        url: "/api/orders",
        status: 500,
        hits: 1,
        stepIndex: null,
        file: null,
      },
      {
        source: "step",
        method: "GET",
        url: "/api/orders/*",
        status: 404,
        hits: 1,
        stepIndex: 3,
        file: null,
      },
      {
        source: "step",
        method: "GET",
        url: "/api/orders",
        status: 503,
        hits: 1,
        stepIndex: null,
        file: null,
      },
    ]);
  });
});

describe("Traffic", () => {
  it("keeps text answers scrubbed, only the content type, and replays them in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "traffic-"));
    dirs.push(dir);
    const file = join(dir, "t.network.har");
    const redact = (text: string) => text.replaceAll("tok-123", "[secret:TOKEN]");
    const record = new Traffic("record", file, "t.har", redact, { name: "x", version: "1" });
    record.keep(
      "GET",
      "http://a.test/api/me?t=tok-123",
      "/api/me?t=tok-123",
      200,
      "OK",
      "application/json",
      Buffer.from('{"token":"tok-123","n":1}'),
    );
    record.keep(
      "GET",
      "http://a.test/api/me?t=tok-123",
      "/api/me?t=tok-123",
      200,
      "OK",
      "application/json",
      Buffer.from('{"n":2}'),
    );
    record.keep(
      "GET",
      "http://a.test/logo.png",
      "/logo.png",
      200,
      "OK",
      "image/png",
      Buffer.from([1, 2, 3]),
    );
    record.save();
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("tok-123");
    const har = JSON.parse(text);
    expect(har.log.entries).toHaveLength(2);
    expect(har.log.entries[0].response.headers).toEqual([
      { name: "content-type", value: "application/json" },
    ]);
    expect(har.log.entries[0]._route).toBe("/api/me?t=[secret:TOKEN]");

    const replay = new Traffic("replay", file, "t.har", redact, { name: "x", version: "1" });
    const where = "/api/me?t=[secret:TOKEN]";
    expect(replay.answer("GET", where)?.body.toString()).toBe('{"token":"[secret:TOKEN]","n":1}');
    expect(replay.answer("GET", where)?.body.toString()).toBe('{"n":2}');
    expect(replay.answer("GET", where)?.body.toString()).toBe('{"n":2}');
    expect(replay.answer("GET", "/api/other")).toBeUndefined();
    expect(replay.use()).toMatchObject({ source: "recorded", hits: 3, file: "t.har" });
  });
});
