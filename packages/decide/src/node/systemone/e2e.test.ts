import { defaultRegistry } from "@optestra/config";
import { processEnvSource } from "@optestra/config/node";
import { describe, expect, it } from "vitest";
import { createDecisions, type DecisionsSettings } from "../../index.js";
import { resolveDecisionBackend } from "./resolve.js";

// Real models, skipped by default (CI makes no network calls):
//   JEV_E2E=1 JEV_API_KEY=… pnpm vitest run packages/decide/src/node/systemone/e2e.test.ts
//   KEV_E2E=1 (Kev on 127.0.0.1:8009)   LAYA_E2E=1 (Ollaya on 127.0.0.1:11435)
const settings = defaultRegistry.defaults().decisions as DecisionsSettings;
const unclear = {
  status: 200,
  title: "Acme",
  heading: "",
  text: "Something went wrong. Please try again later.",
};

for (const id of ["jev", "kev", "laya"] as const) {
  describe.skipIf(process.env[`${id.toUpperCase()}_E2E`] !== "1")(`${id} (real model)`, () => {
    it("answers page_is_error", async () => {
      const selection = resolveDecisionBackend(
        { secrets: {}, decisions: { ...settings, backend: id } },
        { sources: [processEnvSource()] },
      );
      const backend = selection.after.backend;
      expect(backend, selection.problems[0]?.message).not.toBeNull();
      if (!backend) return;
      if (backend.warmUp) expect((await backend.warmUp({ timeoutMs: 20_000 })).ok).toBe(true);
      const decisions = createDecisions({
        config: { decisions: { ...settings, tasks: { page_is_error: { timeLimitMs: 5000 } } } },
        backend,
        bypassCache: true,
      });
      const result = await decisions.decide("page_is_error", unclear);
      expect(["decided", "escalated"]).toContain(result.status);
      if (result.status === "escalated") expect(result.reason).toBe("below_threshold");
      expect(backend.usage().failures).toBe(0);
    }, 30_000);
  });
}
