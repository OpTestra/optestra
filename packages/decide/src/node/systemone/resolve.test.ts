import { defaultRegistry } from "@testament/config";
import { memorySource } from "@testament/config/node";
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

describe("backend selection (no network)", () => {
  it("defaults to auto: none without a key, jev with one", () => {
    expect(base().backend).toBe("auto");
    const none = resolveDecisionBackend(config(), { sources: [], fetch: spy });
    expect(none).toMatchObject({ selected: "none", backend: null, problems: [], warnings: [] });
    expect(none.summary).toBe("auto → none (rules only; set JEV_API_KEY to use Jev)");
    const jev = resolveDecisionBackend(config(), { sources: [key], fetch: spy });
    expect(jev).toMatchObject({ selected: "jev", backend: { id: "jev", host: "api.typesafe.ai" } });
    expect(fetched).toBe(0);
  });

  it("uses Kev and Laya only when chosen, and warns that Laya is untrained", () => {
    expect(resolveDecisionBackend(config(), { sources: [key] }).selected).toBe("jev");
    const laya = resolveDecisionBackend(config({ backend: "laya" }), { sources: [] });
    expect(laya).toMatchObject({
      selected: "laya",
      backend: { host: "127.0.0.1:11435", flavor: "ollaya" },
    });
    expect(laya.warnings.map((w) => w.message)).toEqual([
      "Laya is untrained on this project: expect more escalations.",
    ]);
    const kev = resolveDecisionBackend(config({ backend: "kev" }), { sources: [] });
    expect(kev).toMatchObject({
      selected: "kev",
      backend: { host: "127.0.0.1:8009", flavor: "systemone" },
    });
  });

  it("falls back to rules with a clear problem when the chosen backend's key is missing", () => {
    const result = resolveDecisionBackend(config({ backend: "jev" }), { sources: [] });
    expect(result).toMatchObject({ selected: "none", backend: null });
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
    expect(result.selected).toBe("none");
    expect(result.keys.jev.status).toBe("not_allowed");
    expect(result.warnings[0]?.message).toContain("may not be sent to api.typesafe.ai");
  });
});
