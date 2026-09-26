import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRegistry } from "@testament/config";
import { memorySource, Redactor } from "@testament/config/node";
import type { DecisionRecord } from "@testament/contract";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createDecisions, type DecisionMeta, type DecisionsSettings } from "../../index.js";
import { createSystemOneBackend } from "./client.js";
import { type FakeServer, fixture, startFakeServer } from "./fake-server.test.helpers.js";
import { createProjectDecisions } from "./resolve.js";
import { createTransport, type FetchLike } from "./transport.js";

const servers: FakeServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function fake(handle: FakeServer["handle"]) {
  const server = await startFakeServer(handle);
  servers.push(server);
  return server;
}

const noul = (p: number) => ({
  model: "jev-1.13.0",
  answers: { is_error: { type: "noul", noul: p } },
  usage: { input_tokens: 100, output_tokens: 20 },
});
const QUESTIONS = { is_error: { kind: "noul" as const, instructions: "This is an error page." } };
const call = (
  backend: ReturnType<typeof createSystemOneBackend>,
  timeoutMs = 2000,
  signal?: AbortSignal,
) =>
  backend.answer(
    { state: "HTTP status: 403", questions: QUESTIONS },
    { signal: signal ?? new AbortController().signal, timeoutMs },
  );
const defaults = () => defaultRegistry.defaults().decisions as DecisionsSettings;
const unclear = { status: 403, title: "Acme", heading: "", text: "Please sign in." };

describe("System One client over a loopback server", () => {
  it("Jev/Kev flavor: POST /v1/systemone with the bearer key; records usage and cost", async () => {
    const server = await fake(() => ({ json: noul(0.93) }));
    const backend = createSystemOneBackend({
      id: "jev",
      baseUrl: server.url,
      model: "jev-latest",
      apiKey: "test-key-123",
      flavor: "systemone",
      priceUsdPerMillionInputTokens: 0.042,
    });
    const response = await call(backend);
    expect(response).toMatchObject({
      ok: true,
      answers: { is_error: { value: true, confidence: 0.93 } },
    });
    const [request] = server.received;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/v1/systemone");
    expect(request?.headers.authorization).toBe("Bearer test-key-123");
    expect(request?.body).toEqual({
      model: "jev-latest",
      state: "HTTP status: 403",
      questions: { is_error: { type: "noul", instructions: "This is an error page." } },
    });
    expect(backend.usage()).toMatchObject({ requests: 1, inputTokens: 100 });
    expect(backend.usage().costUsd).toBeCloseTo(0.0000042, 12);
  });

  it("Ollaya flavor: POST /api/decide with keep_alive, no key header, state_truncated reported", async () => {
    const server = await fake(() => ({
      json: {
        ...(fixture("ollaya-decide.json") as object),
        answers: noul(0.1).answers,
        state_truncated: true,
      },
    }));
    const backend = createSystemOneBackend({
      id: "laya",
      baseUrl: server.url,
      model: "laya:typed-decisions",
      flavor: "ollaya",
      keepAlive: "30m",
    });
    const response = await call(backend);
    expect(response).toMatchObject({
      ok: true,
      stateTruncated: true,
      model: "laya:typed-decisions",
    });
    expect(server.received[0]?.path).toBe("/api/decide");
    expect(server.received[0]?.headers.authorization).toBeUndefined();
    expect(server.received[0]?.body).toMatchObject({ keep_alive: "30m" });
    expect(backend.usage().truncatedStates).toBe(1);
  });

  it.each([
    [{ status: 429, json: {} }, "rate_limited"],
    [{ status: 500, json: { error: "boom", code: "INTERNAL" } }, "server_error"],
    [{ status: 529, json: {} }, "overloaded"],
    [{ status: 404, json: fixture("ollaya-error-model-not-found.json") }, "model_not_found"],
    [{ status: 401, json: fixture("jev-error-401.json") }, "unauthorized"],
    [{ status: 200, raw: "{not json" }, "invalid_response"],
    [
      {
        status: 200,
        json: { answers: { is_error: { type: "choice", choice: "x", confidence: 1 } } },
      },
      "invalid_response",
    ],
    [
      { status: 200, json: { answers: { is_error: { type: "noul", noul: 1.7 } } } },
      "invalid_response",
    ],
    [{ hangUp: true }, "unavailable"],
  ])("fails cleanly on %j → %s", async (reply, reason) => {
    const server = await fake(() => reply);
    const backend = createSystemOneBackend({
      id: "jev",
      baseUrl: server.url,
      model: "m",
      flavor: "systemone",
    });
    const response = await call(backend);
    expect(response).toMatchObject({ ok: false, failure: { reason } });
    expect(backend.usage().failures).toBe(1);
  });

  it("times out and aborts mid-call", async () => {
    const server = await fake(() => ({ json: noul(0.9), delayMs: 3000 }));
    const backend = createSystemOneBackend({
      id: "jev",
      baseUrl: server.url,
      model: "m",
      flavor: "systemone",
    });
    const started = performance.now();
    expect(await call(backend, 50)).toMatchObject({ ok: false, failure: { reason: "timeout" } });
    expect(performance.now() - started).toBeLessThan(1500);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    expect(await call(backend, 2000, controller.signal)).toMatchObject({
      ok: false,
      failure: { reason: "aborted" },
    });
  });

  it("reports an unreachable backend (Ollaya not running) as unavailable", async () => {
    const server = await fake(() => ({ json: {} }));
    const url = server.url;
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const backend = createSystemOneBackend({
      id: "laya",
      baseUrl: url,
      model: "m",
      flavor: "ollaya",
    });
    expect(await call(backend)).toMatchObject({ ok: false, failure: { reason: "unavailable" } });
  });

  it("runs the state through the redactor: a planted secret never reaches the server", async () => {
    const server = await fake(() => ({ json: noul(0.9) }));
    const redactor = new Redactor();
    redactor.register("hunter2-planted-secret", "[secret:PASSWORD]");
    const backend = createSystemOneBackend({
      id: "jev",
      baseUrl: server.url,
      model: "m",
      flavor: "systemone",
      scrub: (text) => redactor.redact(text),
    });
    const decisions = createDecisions({ backend });
    await decisions.decide("page_is_error", {
      ...unclear,
      text: "password: hunter2-planted-secret",
    });
    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.raw).not.toContain("hunter2-planted-secret");
    expect(server.received[0]?.raw).toContain("[secret:PASSWORD]");
  });

  it("sends the key only to its own host", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const recording: FetchLike = async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(noul(0.9)), {
        headers: { "content-type": "application/json" },
      });
    };
    const backend = createSystemOneBackend({
      id: "jev",
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      apiKey: "k-1",
      flavor: "systemone",
      fetch: recording,
    });
    await call(backend);
    expect(calls).toEqual([{ url: "https://api.typesafe.ai/v1/systemone", auth: "Bearer k-1" }]);

    // A path that would leave the host is refused before any request is made.
    const transport = createTransport("https://api.typesafe.ai", recording);
    expect(
      await transport.request({ method: "GET", path: "//evil.example/steal", timeoutMs: 100 }),
    ).toMatchObject({ kind: "error", reason: "blocked" });
    expect(calls).toHaveLength(1);
  });
});

describe("through the decision pipeline", () => {
  function project(server: FakeServer, patch: Partial<DecisionsSettings> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "decide-s1-"));
    dirs.push(dir);
    const base = defaults();
    return {
      dir,
      config: {
        secrets: {},
        decisions: {
          ...base,
          backend: "laya" as const,
          laya: { ...base.laya, baseUrl: server.url },
          ...patch,
        },
      },
    };
  }

  it("warms Laya up at run start without recording a decision", async () => {
    const server = await fake(() => ({
      json: {
        ...(fixture("ollaya-decide.json") as object),
        answers: { ready: { type: "noul", noul: 0.8 } },
      },
    }));
    const records: DecisionRecord[] = [];
    const { dir, config } = project(server);
    const run = createProjectDecisions({
      config,
      projectDir: dir,
      onDecision: (r) => records.push(r),
      sources: [],
    });
    expect(run.selection.during.selected).toBe("laya");
    expect(run.selection.after.selected).toBe("laya");
    expect(run.selection.warnings[0]?.message).toContain("untrained");
    const warm = await run.warmUp();
    expect(warm).toMatchObject({ ok: true, skipped: false });
    expect(server.received).toHaveLength(1);
    expect(records).toEqual([]);
    expect(run.decisions.metrics()).toEqual({});
  });

  it("gives the exact fix when the warm-up can't reach Ollaya or the model is missing", async () => {
    const server = await fake(() => ({
      status: 404,
      json: fixture("ollaya-error-model-not-found.json"),
    }));
    const { dir, config } = project(server);
    const warm = await createProjectDecisions({ config, projectDir: dir, sources: [] }).warmUp();
    expect(warm).toMatchObject({ ok: false, failure: expect.stringContaining("MODEL_NOT_FOUND") });
    expect(warm.fix).toMatch(/decider setup laya --model laya:typed-decisions/);
  });

  it("keeps deciding by rules when Ollaya quits mid-run", async () => {
    const server = await fake(() => ({ json: noul(0.97) }));
    const metas: DecisionMeta[] = [];
    const { dir, config } = project(server);
    const run = createProjectDecisions({
      config,
      projectDir: dir,
      sources: [],
      bypassCache: true,
      onDecision: (_r, m) => metas.push(m),
    });
    expect(await run.decisions.decide("page_is_error", unclear)).toMatchObject({
      status: "decided",
      source: "laya",
    });
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const started = performance.now();
    const after = await run.decisions.decide("page_is_error", unclear);
    expect(after).toMatchObject({ status: "escalated", reason: "backend_error" });
    expect(metas.at(-1)?.backend).toEqual({ failure: "unavailable" });
    expect(performance.now() - started).toBeLessThan(1500);
    // Clear cases are still decided by the rules.
    expect(await run.decisions.decide("page_is_error", { ...unclear, status: 503 })).toMatchObject({
      status: "decided",
      source: "rules",
    });
  });

  it("cuts a slow backend off at the task's 100 ms limit", async () => {
    const server = await fake(() => ({ json: noul(0.97), delayMs: 3000 }));
    const { dir, config } = project(server);
    const run = createProjectDecisions({ config, projectDir: dir, sources: [], bypassCache: true });
    const result = await run.decisions.decide("page_is_error", unclear);
    expect(result).toMatchObject({ status: "escalated", reason: "timeout" });
    // Cut off at the 100 ms limit, long before the 3 s reply (margin for slow CI machines).
    expect(result.latencyMs).toBeLessThan(1500);
  });

  it("auto uses Jev for after-run tasks only when its key is set, and sends it as the bearer token", async () => {
    // Answers every question it is asked: nouls yes, choices their first option.
    const server = await fake(({ body }) => {
      const questions = (body as { questions: Record<string, { type: string; criteria?: object }> })
        .questions;
      return {
        json: {
          model: "jev-1.13.0",
          answers: Object.fromEntries(
            Object.entries(questions).map(([id, q]) => [
              id,
              q.type === "noul"
                ? { type: "noul", noul: 0.95 }
                : {
                    type: "choice",
                    choice: Object.keys(q.criteria ?? {})[0],
                    confidence: 0.95,
                    probabilities: {},
                  },
            ]),
          ),
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      };
    });
    const base = defaults();
    const config = {
      secrets: {},
      decisions: { ...base, backend: "auto" as const, jev: { ...base.jev, baseUrl: server.url } },
    };
    const dir = mkdtempSync(join(tmpdir(), "decide-s1-"));
    dirs.push(dir);
    // One 500, no retry: the rules can't tell, so the after-run backend is asked.
    const unclearFailure = {
      verdict: "failed" as const,
      failingAttempt: 1,
      attempts: [
        {
          attempt: 1,
          status: "failed" as const,
          failedStep: 3,
          failedCheck: null,
          serverErrors: 1,
          networkFailures: 0,
          errorPage: null,
        },
      ],
      failingStep: {
        attempt: 1,
        index: 3,
        text: "Click 'Save'",
        kind: "action" as const,
        recovery: "none" as const,
        error: null,
        notFound: false,
        postState: "mismatch" as const,
        flow: null,
      },
      failingCheck: null,
      requests: [
        { method: "PUT", path: "/api/profile", status: 500, document: false, thirdParty: false },
      ],
      consoleErrors: [],
      page: null,
      pageIsError: null,
    };
    const withKey = createProjectDecisions({
      config,
      projectDir: dir,
      sources: [memorySource({ JEV_API_KEY: "jev-test-key" })],
      bypassCache: true,
    });
    expect(withKey.selection.after.summary).toBe("auto → jev (JEV_API_KEY set)");
    expect(withKey.selection.during.selected).toBe("none");
    expect(await withKey.warmUp()).toMatchObject({ skipped: true });
    expect(await withKey.decisions.decide("failure_cause", unclearFailure)).toMatchObject({
      status: "decided",
      source: "jev",
      answers: { cause: "product_bug" },
    });
    expect(server.received[0]?.headers.authorization).toBe("Bearer jev-test-key");
    // During-run tasks never go to Jev (rules only by default).
    await withKey.decisions.decide("page_is_error", unclear);
    expect(server.received).toHaveLength(1);

    const without = createProjectDecisions({ config, projectDir: dir, sources: [] });
    expect(without.selection.after).toMatchObject({ selected: "none", backend: null });
    await without.decisions.decide("failure_cause", unclearFailure);
    expect(server.received).toHaveLength(1);
  });
});
