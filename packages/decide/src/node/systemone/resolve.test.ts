import { defaultRegistry } from "@optestra/config";
import { memorySource } from "@optestra/config/node";
import { describe, expect, it } from "vitest";
import type { DecisionsSettings } from "../../index.js";
import { resolveDecisionBackend } from "./resolve.js";
import type { FetchLike } from "./transport.js";

const base = () => defaultRegistry.defaults().decisions as DecisionsSettings;
const config = (patch: Partial<DecisionsSettings> = {}, secrets = {}) => ({
  secrets,
  decisions: { ...base(), ...patch },
});
let fetched = 0;
const spy: FetchLike = async () => {
  fetched++;
  return new Response("{}");
};
const key = memorySource({ JEV_API_KEY: "jev-k", OLLAYA_KEY: "o-k" });

describe("per-phase backend selection (no network)", () => {
  it("defaults to auto: during → rules only; after → Jev with a key, else rules only", () => {
    expect([base().backend, base().during, base().after]).toEqual(["auto", "auto", "auto"]);
    const none = resolveDecisionBackend(config(), { sources: [], fetch: spy });
    expect(none.during).toMatchObject({
      selected: "none",
      backend: null,
      summary: "auto → none (rules only)",
    });
    expect(none.after).toMatchObject({
      selected: "none",
      backend: null,
      summary: "auto → none (rules only; set JEV_API_KEY to use Jev)",
    });
    expect(none.problems).toEqual([]);
    const jev = resolveDecisionBackend(config(), { sources: [key], fetch: spy });
    expect(jev.during.selected).toBe("none");
    expect(jev.after).toMatchObject({
      selected: "jev",
      summary: "auto → jev (JEV_API_KEY set)",
      backend: { id: "jev", host: "api.typesafe.ai", expectedLatencyMs: 400 },
    });
    expect(fetched).toBe(0);
  });

  it("`backend` is the shorthand for both phases; a phase setting wins", () => {
    const laya = resolveDecisionBackend(config({ backend: "laya" }), { sources: [] });
    expect(laya.during).toMatchObject({ selected: "laya", summary: "auto → laya (from backend)" });
    expect(laya.after.selected).toBe("laya");
    // One instance serves both phases, so usage is counted once.
    expect(laya.during.backend).toBe(laya.after.backend);
    expect(laya.during.backend).toMatchObject({ host: "127.0.0.1:11435", flavor: "ollaya" });
    expect(laya.warnings.map((w) => w.message)).toEqual([
      "Laya is untrained on this project: expect more escalations.",
    ]);
    const mixed = resolveDecisionBackend(config({ during: "laya", after: "jev" }), {
      sources: [key],
    });
    expect([mixed.during.selected, mixed.after.selected]).toEqual(["laya", "jev"]);
    const offDuring = resolveDecisionBackend(config({ backend: "jev", during: "none" }), {
      sources: [key],
    });
    expect([offDuring.during.selected, offDuring.after.selected]).toEqual(["none", "jev"]);
  });

  it("uses Kev and Laya only when named, and warns when a during backend is too slow", () => {
    expect(resolveDecisionBackend(config(), { sources: [key] }).after.selected).toBe("jev");
    const kev = resolveDecisionBackend(config({ backend: "kev" }), { sources: [] });
    expect(kev.after).toMatchObject({
      selected: "kev",
      backend: { host: "127.0.0.1:8009", flavor: "systemone" },
    });
    expect(kev.warnings.map((w) => w.message).join()).toContain(
      "slower than the 100 ms during-run limit",
    );
  });

  it("falls back to rules with a clear problem when the chosen backend's key is missing", () => {
    const result = resolveDecisionBackend(config({ backend: "jev" }), { sources: [] });
    expect(result.after).toMatchObject({ selected: "none", backend: null });
    expect(result.during.selected).toBe("none");
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.message).toContain("JEV_API_KEY is not set");
    const laya = base().laya;
    const withKeySecret = resolveDecisionBackend(
      config({ backend: "laya", laya: { ...laya, keySecret: "OLLAYA_KEY" } }),
      { sources: [key] },
    );
    expect(withKeySecret.keys.laya.status).toBe("set");
  });

  it("refuses a declared key whose domains don't include the backend host", () => {
    const result = resolveDecisionBackend(
      config({}, { JEV_API_KEY: { domains: ["example.com"] } }),
      { sources: [key] },
    );
    expect(result.after.selected).toBe("none");
    expect(result.keys.jev.status).toBe("not_allowed");
    expect(result.warnings[0]?.message).toContain("may not be sent to api.typesafe.ai");
  });
});
