import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalModel,
  checkLaya,
  checkSystemOne,
  formatBytes,
  hasModel,
  ollayaStatus,
  pullModel,
} from "./admin.js";
import { type FakeServer, fixture, startFakeServer } from "./fake-server.test.helpers.js";

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A fake Ollaya 0.6.1 with laya:typed-decisions installed. */
async function ollaya(
  extra: (path: string, body: unknown) => object | undefined = () => undefined,
) {
  const server = await startFakeServer(({ path, body }) => {
    const reply = extra(path, body);
    if (reply) return reply;
    if (path === "/") return { raw: "Ollaya is running" };
    if (path === "/api/version") return { json: { version: "0.6.1" } };
    if (path === "/api/tags") return { json: fixture("ollaya-tags.json") };
    return { status: 404, json: { error: "not found", code: "NOT_FOUND" } };
  });
  servers.push(server);
  return server;
}

describe("Ollaya setup and checks", () => {
  it("finds Ollaya, its version and installed models", async () => {
    const server = await ollaya();
    const status = await ollayaStatus({ baseUrl: server.url });
    expect(status).toMatchObject({ running: true, version: "0.6.1" });
    expect(status.models).toEqual([
      { name: "laya:typed-decisions", size: 853527607, parameterSize: "421M" },
    ]);
    expect(hasModel(status, "LAYA:typed-decisions")).toBe(true);
    expect(hasModel(status, "laya")).toBe(false);
    expect(canonicalModel("laya")).toBe("laya:latest");
    expect(formatBytes(853527607)).toBe("854 MB");
    expect(
      await checkLaya({ baseUrl: server.url, model: "laya:typed-decisions", apiKey: undefined }),
    ).toMatchObject({
      status: "ok",
      version: "0.6.1",
    });
    expect(
      await checkLaya({ baseUrl: server.url, model: "laya:en", apiKey: undefined }),
    ).toMatchObject({
      status: "model_missing",
      fix: expect.stringContaining("decider setup laya --model laya:en"),
    });
  });

  it("says exactly what to do when Ollaya isn't running", async () => {
    const server = await ollaya();
    const url = server.url;
    await server.close();
    servers.length = 0;
    const status = await ollayaStatus({ baseUrl: url });
    expect(status.running).toBe(false);
    expect(status.problem).toContain("Ollaya is not running");
    expect(status.fix).toMatch(/Ollaya/);
    expect((await checkLaya({ baseUrl: url, model: "laya", apiKey: undefined })).status).toBe(
      "unreachable",
    );
  });

  it("pulls a model with streamed progress, and reports a failed pull", async () => {
    const server = await ollaya((path, body) =>
      path === "/api/pull"
        ? (body as { model: string }).model === "laya:en"
          ? {
              lines: [
                { status: "pulling manifest" },
                { status: "pulling 891102d37268", total: 100, completed: 50 },
                { status: "pulling 891102d37268", total: 100, completed: 100 },
                { status: "verifying sha256 digest" },
                { status: "success" },
              ],
            }
          : {
              lines: [
                { status: "pulling manifest" },
                { error: "digest mismatch", code: "DIGEST_MISMATCH" },
              ],
            }
        : undefined,
    );
    const seen: string[] = [];
    expect(await pullModel({ baseUrl: server.url }, "laya:en", (p) => seen.push(p.status))).toEqual(
      { ok: true },
    );
    expect(seen).toContain("verifying sha256 digest");
    expect(await pullModel({ baseUrl: server.url }, "laya:bad", () => {})).toEqual({
      ok: false,
      message: "DIGEST_MISMATCH: digest mismatch",
    });
  });
});

describe("Jev / Kev checks", () => {
  it("checks the key with GET /v1/models (no tokens spent)", async () => {
    const server = await startFakeServer(({ headers }) =>
      headers.authorization === "Bearer good"
        ? { json: fixture("jev-models.json") }
        : { status: 401, json: fixture("jev-error-401.json") },
    );
    servers.push(server);
    const opts = {
      backend: "jev" as const,
      baseUrl: server.url,
      model: "jev-latest",
      keySecret: "JEV_API_KEY",
    };
    expect(await checkSystemOne({ ...opts, apiKey: "good" as never })).toMatchObject({
      status: "ok",
      message: "key valid; model jev-latest listed",
    });
    expect(await checkSystemOne({ ...opts, apiKey: "bad" as never })).toMatchObject({
      status: "invalid_key",
    });
    expect(await checkSystemOne({ ...opts, apiKey: undefined })).toMatchObject({
      status: "missing_key",
    });
    expect(server.received.every((r) => r.path === "/v1/models" && r.method === "GET")).toBe(true);
  });
});
