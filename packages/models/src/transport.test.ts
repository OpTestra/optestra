import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkProviders } from "./check.js";
import { createModels } from "./client.js";
import { captureLogs, KEYS, keySources, testConfig } from "./test-kit.test-support.js";
import { BlockedHostError, guardedFetch } from "./transport.js";

interface Fake {
  server: Server;
  host: string;
  seen: IncomingHttpHeaders[];
  respond: (path: string, headers: IncomingHttpHeaders) => { status: number; body: unknown };
}

const completion = (text: string, cost?: number) => ({
  id: "c",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    ...(cost !== undefined && { cost }),
  },
});

async function fake(respond: Fake["respond"]): Promise<Fake> {
  const state = { seen: [] as IncomingHttpHeaders[], respond };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      state.seen.push(req.headers);
      const { status, body } = state.respond(req.url ?? "", req.headers);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(state, { server, host });
}

let a: Fake;
let b: Fake;
beforeAll(async () => {
  a = await fake(() => ({ status: 429, body: { error: { message: "slow down" } } }));
  b = await fake(() => ({ status: 200, body: completion("from b", 0.0042) }));
});
afterAll(() => {
  a.server.close();
  b.server.close();
});

const loopbackConfig = () =>
  testConfig({
    providers: {
      a: { kind: "openai-compatible", baseUrl: `http://${a.host}/v1`, keySecret: "A_KEY" },
      b: { kind: "openai-compatible", baseUrl: `http://${b.host}/v1`, keySecret: "B_KEY" },
    },
  });

describe("real transport over loopback", () => {
  it("fails over from a 429 provider to the next, with every attempt recorded", async () => {
    const client = createModels({ config: loopbackConfig(), sources: keySources(), backoffMs: 0 });
    const result = await client.complete("planner", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.ok && result.text).toBe("from b");
    expect(result.attempts.map((x) => [x.provider, x.outcome, x.status])).toEqual([
      ["a", "rate_limited", 429],
      ["a", "rate_limited", 429],
      ["a", "rate_limited", 429],
      ["b", "ok", undefined],
    ]);
  });

  it("prefers provider-reported cost over the price table", async () => {
    const client = createModels({ config: loopbackConfig(), sources: keySources(), backoffMs: 0 });
    const result = await client.complete("planner", {
      messages: [{ role: "user", content: "hi" }],
    });
    // gpt-6-sol is in prices.yaml, but the provider said 0.0042.
    expect(result.ok && result.costUsd).toBe(0.0042);
  });

  it("sends each key only to its own provider's host", () => {
    const authA = a.seen.map((h) => h.authorization);
    const authB = b.seen.map((h) => h.authorization);
    expect(new Set(authA)).toEqual(new Set([`Bearer ${KEYS.A_KEY}`]));
    expect(new Set(authB)).toEqual(new Set([`Bearer ${KEYS.B_KEY}`]));
  });

  it("never lets a key echoed in an error body reach results, records or logs", async () => {
    a.respond = (_path, headers) => ({
      status: 401,
      body: { error: `bad key ${headers.authorization}` },
    });
    b.respond = () => ({ status: 500, body: { error: `upstream saw ${KEYS.B_KEY}` } });
    const logs = captureLogs();
    const records: unknown[] = [];
    const client = createModels({
      config: loopbackConfig(),
      sources: keySources(),
      backoffMs: 0,
      logger: logs.logger,
      onCall: (r) => records.push(r),
    });
    const result = await client.complete("planner", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.ok).toBe(false);
    const everything = JSON.stringify({ result, records }) + logs.lines.join("\n");
    expect(everything).toContain("[secret:A_KEY]");
    expect(everything).not.toContain(KEYS.A_KEY);
    expect(everything).not.toContain(KEYS.B_KEY);
  });

  it("refuses to send a request to any other host", async () => {
    const request = guardedFetch(a.host);
    await expect(request(`http://${b.host}/v1/models`)).rejects.toBeInstanceOf(BlockedHostError);
  });
});

describe("checkProviders", () => {
  it("reports valid, invalid key, no key and unreachable", async () => {
    const good = await fake((_path, headers) =>
      headers.authorization === `Bearer ${KEYS.A_KEY}`
        ? { status: 200, body: { data: [] } }
        : { status: 401, body: {} },
    );
    const closed = await fake(() => ({ status: 200, body: {} }));
    closed.server.close();
    const config = testConfig({
      providers: {
        valid: { kind: "openai-compatible", baseUrl: `http://${good.host}/v1`, keySecret: "A_KEY" },
        wrong: { kind: "openai-compatible", baseUrl: `http://${good.host}/v1`, keySecret: "B_KEY" },
        missing: {
          kind: "openai-compatible",
          baseUrl: `http://${good.host}/v1`,
          keySecret: "NOT_SET",
        },
        down: {
          kind: "openai-compatible",
          baseUrl: `http://${closed.host}/v1`,
          keySecret: "A_KEY",
        },
      },
      roles: { planner: [], fixer: [] },
    });
    const checks = await checkProviders(config, { sources: keySources() });
    const status = Object.fromEntries(checks.map((c) => [c.provider, c.status]));
    expect(status).toMatchObject({
      valid: "valid",
      wrong: "invalid_key",
      missing: "no_key",
      down: "unreachable",
    });
    expect(status).toMatchObject({ anthropic: "no_key", openai: "no_key", google: "no_key" });
    expect(good.seen.every((h) => h.authorization !== undefined)).toBe(true);
    expect(JSON.stringify(checks)).not.toContain(KEYS.B_KEY);
    good.server.close();
  });

  it("uses each provider's own auth header", async () => {
    const seen = await fake(() => ({ status: 200, body: { data: [] } }));
    const config = testConfig({
      providers: {
        claude: { kind: "anthropic", baseUrl: `http://${seen.host}/v1`, keySecret: "A_KEY" },
      },
      roles: { planner: [], fixer: [] },
    });
    const [check] = (await checkProviders(config, { sources: keySources() })).filter(
      (c) => c.provider === "claude",
    );
    expect(check?.status).toBe("valid");
    expect(seen.seen[0]?.["x-api-key"]).toBe(KEYS.A_KEY);
    expect(seen.seen[0]?.["anthropic-version"]).toBe("2023-06-01");
    seen.server.close();
  });
});
