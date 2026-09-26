import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A loopback stand-in for Jev, Kev or Ollaya. Tests only; never leaves 127.0.0.1. */

export interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
  raw: string;
}

export interface Reply {
  status?: number;
  /** JSON body (serialized) … */
  json?: unknown;
  /** … or a raw body. */
  raw?: string;
  /** NDJSON lines, streamed. */
  lines?: unknown[];
  delayMs?: number;
  /** Destroy the socket instead of answering. */
  hangUp?: boolean;
}

export interface FakeServer {
  url: string;
  received: Received[];
  handle: (request: Received) => Reply | Promise<Reply>;
  close(): Promise<void>;
}

export async function startFakeServer(
  handle: (request: Received) => Reply | Promise<Reply>,
): Promise<FakeServer> {
  const received: Received[] = [];
  const fake = { handle } as FakeServer;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", async () => {
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const request: Received = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body,
        raw,
      };
      received.push(request);
      const reply = await fake.handle(request);
      if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      if (reply.hangUp) {
        req.socket.destroy();
        return;
      }
      if (res.destroyed) return;
      if (reply.lines) {
        res.writeHead(reply.status ?? 200, { "content-type": "application/x-ndjson" });
        for (const line of reply.lines) res.write(`${JSON.stringify(line)}\n`);
        res.end();
        return;
      }
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(reply.raw ?? (reply.json === undefined ? "" : JSON.stringify(reply.json)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.received = received;
  fake.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}

/** A recorded example from `fixtures/systemone/`. */
export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../fixtures/systemone/${name}`, import.meta.url), "utf8"),
  );
}
