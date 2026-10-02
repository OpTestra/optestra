import { describe, expect, it } from "vitest";
import { AiWaits, rateLimitWaitMs, retryAfterMs, Slots } from "./limits.js";

describe("Retry-After", () => {
  const now = Date.parse("2026-10-02T12:00:00.000Z");

  it("reads seconds and HTTP dates; ignores what it can't read", () => {
    expect(retryAfterMs("30", now)).toBe(30_000);
    expect(retryAfterMs("1.5", now)).toBe(1_500);
    expect(retryAfterMs("Fri, 02 Oct 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(retryAfterMs("Fri, 02 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(retryAfterMs("soon", now)).toBeUndefined();
    expect(retryAfterMs(undefined, now)).toBeUndefined();
  });

  it("falls back to X-RateLimit-Reset (epoch seconds or ms), any header case", () => {
    expect(rateLimitWaitMs({ "Retry-After": "5" }, now)).toBe(5_000);
    expect(rateLimitWaitMs({ "x-ratelimit-reset": String(now / 1000 + 20) }, now)).toBe(20_000);
    expect(rateLimitWaitMs({ "X-RateLimit-Reset": String(now + 7_000) }, now)).toBe(7_000);
    expect(rateLimitWaitMs({}, now)).toBeUndefined();
    expect(rateLimitWaitMs(undefined, now)).toBeUndefined();
  });
});

describe("Slots", () => {
  it("hands out at most `size` slots, first come first served", async () => {
    const slots = new Slots(2);
    const order: string[] = [];
    const a = await slots.acquire();
    const b = await slots.acquire();
    expect(slots.free).toBe(false);
    const c = slots.acquire().then((release) => {
      order.push("c");
      return release;
    });
    const d = slots.acquire().then((release) => {
      order.push("d");
      return release;
    });
    a();
    a(); // releasing twice frees one slot only
    (await c)();
    b();
    (await d)();
    expect(order).toEqual(["c", "d"]);
    expect(slots.free).toBe(true);
  });

  it("a cancelled wait leaves the queue", async () => {
    const slots = new Slots(1);
    const held = await slots.acquire();
    const controller = new AbortController();
    const waiting = slots.acquire(controller.signal);
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
    held();
    expect(slots.free).toBe(true);
  });
});

describe("AiWaits", () => {
  it("adds up overlapping waits once and tells listeners when the last one ends", () => {
    let clock = 0;
    const seen: string[] = [];
    const waits = new AiWaits(
      (info) => seen.push(info.reason),
      () => clock,
    );
    let idle = 0;
    waits.onIdle(() => idle++);
    waits.begin({
      provider: "p",
      model: "m",
      reason: "rate_limited",
      resumesAt: null,
      message: "",
    });
    clock = 100;
    waits.begin();
    clock = 300;
    waits.end();
    expect(waits.waiting).toBe(true);
    expect(waits.waitedMs).toBe(300);
    clock = 500;
    waits.end();
    expect(waits.waiting).toBe(false);
    expect(waits.waitedMs).toBe(500);
    expect(idle).toBe(1);
    expect(seen).toEqual(["rate_limited"]);
    waits.end(); // an extra end changes nothing
    expect(waits.waitedMs).toBe(500);
  });
});
