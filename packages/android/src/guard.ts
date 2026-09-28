import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo, isIP, type Socket, connect as tcpConnect } from "node:net";
import type { Allowlist } from "@testament/browser";
import { HttpLog } from "./http-log.js";
import { MAX_SNIFF_BYTES, type Sniffed, sniff } from "./sniff.js";
import type { AndroidRefusal, RequestSummary } from "./types.js";

// The host-side network guard (SAF-1, MOB-7): the emulator's `-http-proxy`. Every
// TCP connection the device makes arrives here, and nothing leaves unless the
// session's allowlist allows it:
//
// - plain HTTP to port 80 arrives as a proxy request with the absolute URL: the
//   host name is checked, then the guard makes the request itself;
// - everything else arrives as `CONNECT <ip>:<port>`. The guard reads the
//   client's first message for the host name (TLS SNI or the HTTP Host header),
//   checks it, checks that the IP really is one of that name's addresses (so a
//   forged name can't reach another server), and only then connects to that IP;
// - with no name (another protocol), only an IP address in the allowlist passes.
//
// The emulator's host alias 10.0.2.2 is this machine's loopback: an allowed
// `10.0.2.2:<port>` connects to 127.0.0.1:<port> here (a local dev server), and
// nothing else on this machine is reachable. Plain HTTP inside tunnels is read
// to log each request. Without a policy (between sessions, while preparing a
// snapshot) it refuses everything. It binds to 127.0.0.1 only.

export const GUARD_HOST = "127.0.0.1";
const SNIFF_TIMEOUT_MS = 3_000;
const UPSTREAM_TIMEOUT_MS = 30_000;
const DNS_TTL_MS = 60_000;
const DROP_HEADERS = new Set([
  "proxy-connection",
  "proxy-authorization",
  "connection",
  "keep-alive",
]);

export interface GuardPolicy {
  allowlist: Allowlist;
  onRefused(refusal: AndroidRefusal): void;
  onRequest(request: RequestSummary): void;
}

/** The emulator's name for this machine's loopback. */
export const HOST_ALIAS = "10.0.2.2";

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

/** Where to connect for an address the device used: the host alias is this machine's loopback. */
export const upstreamHost = (host: string) => (host === HOST_ALIAS ? GUARD_HOST : host);

const defaultPort = (scheme: "http" | "https") => (scheme === "https" ? 443 : 80);

function urlFor(scheme: "http" | "https", host: string, port: number, path = "/"): string {
  const name = isIP(host) === 6 ? `[${host}]` : host;
  return `${scheme}://${name}${port === defaultPort(scheme) ? "" : `:${port}`}${path}`;
}

/** `ip:port` or `[v6]:port` from a CONNECT line. */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  const match = /^\[([^\]]+)\]:(\d{1,5})$/.exec(target) ?? /^([^:]+):(\d{1,5})$/.exec(target);
  if (!match) return null;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535 ? { host: (match[1] as string).toLowerCase(), port } : null;
}

export class NetworkGuard {
  readonly #server: Server;
  readonly url: string;
  #policy: GuardPolicy | null = null;
  readonly #sockets = new Set<Socket>();
  readonly #dns = new Map<string, { at: number; addresses: string[] }>();
  #pending = 0;
  #lastActivity = Date.now();
  readonly #logs = new Set<HttpLog>();

  private constructor(server: Server, port: number) {
    this.#server = server;
    this.url = `http://${GUARD_HOST}:${port}`;
  }

  static async start(): Promise<NetworkGuard> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, GUARD_HOST, () => resolve());
    });
    const guard = new NetworkGuard(server, (server.address() as AddressInfo).port);
    server.on("request", (req, res) => guard.#onRequest(req, res));
    server.on("connect", (req, socket, head) => guard.#onConnect(req, socket as Socket, head));
    server.on("upgrade", (_req, socket) => socket.destroy());
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("connection", (socket) => guard.#track(socket));
    return guard;
  }

  /** The session's rules, or null to refuse everything. Drops every open connection. */
  setPolicy(policy: GuardPolicy | null): void {
    this.#policy = policy;
    this.dropConnections();
  }

  dropConnections(): void {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#logs.clear();
    this.#pending = 0;
  }

  /** Requests in flight and when bytes last moved, for settle. */
  activity(): { inflight: number; lastActivityAt: number } {
    let inflight = this.#pending;
    for (const log of this.#logs) inflight += log.inflight;
    return { inflight, lastActivityAt: this.#lastActivity };
  }

  async close(): Promise<void> {
    this.#policy = null;
    this.dropConnections();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #track(socket: Socket): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }

  #touch(): void {
    this.#lastActivity = Date.now();
  }

  #refuse(url: string): void {
    this.#policy?.onRefused({ url, type: "proxy", frame: "", at: new Date().toISOString() });
  }

  #log(method: string, url: string, resourceType: string, status: RequestSummary["status"]): void {
    this.#policy?.onRequest({ method, url, resourceType, status });
  }

  // ── Plain HTTP (port 80): proxy requests with an absolute URL ─────────────

  #onRequest(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    this.#touch();
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const policy = this.#policy;
    if (!policy || url.protocol !== "http:" || !policy.allowlist.allowsUrl(url)) {
      if (policy) this.#refuse(url.href);
      res.writeHead(403, { "content-type": "text/plain", connection: "close" });
      res.end("Blocked: host not in allowed domains.\n");
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined && !DROP_HEADERS.has(key)) headers[key] = value;
    }
    this.#pending++;
    let settled = false;
    const finish = (status: RequestSummary["status"]) => {
      if (settled) return;
      settled = true;
      this.#pending--;
      this.#touch();
      this.#log(req.method ?? "GET", url.href, "http", status);
    };
    const upstream = httpRequest(
      {
        host: upstreamHost(url.hostname),
        port: url.port || 80,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (response) => {
        // One request per connection: the emulator's proxy pools its connections to
        // this guard across sessions (and snapshot restores), and a pooled one this
        // side has already closed (idle timeout, a session reset) fails the app's
        // request before it gets here.
        const { connection: _c, "keep-alive": _k, ...kept } = response.headers;
        res.shouldKeepAlive = false;
        res.writeHead(response.statusCode ?? 502, { ...kept, connection: "close" });
        response.on("data", () => this.#touch());
        response.pipe(res);
        response.once("end", () => finish(response.statusCode ?? 502));
      },
    );
    upstream.once("timeout", () => upstream.destroy());
    upstream.once("error", () => {
      finish("failed");
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("data", () => this.#touch());
    req.pipe(upstream);
  }

  // ── Tunnels: CONNECT <ip>:<port> ──────────────────────────────────────────

  #onConnect(req: IncomingMessage, client: Socket, head: Buffer): void {
    this.#touch();
    const parsed = parseConnectTarget(req.url ?? "");
    // The emulator rewrites its host alias to the host's loopback before proxying;
    // the device's own loopback never leaves it, so loopback here means 10.0.2.2.
    const target = parsed && LOOPBACK.has(parsed.host) ? { ...parsed, host: HOST_ALIAS } : parsed;
    const policy = this.#policy;
    if (!policy || !target) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    this.#pending++;
    let buffered = head.length ? Buffer.from(head) : Buffer.alloc(0);
    let decided = false;
    const decide = (sniffed: Sniffed) => {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      client.off("data", onData);
      client.pause();
      this.#pending--;
      void this.#openTunnel(policy, client, target, sniffed, buffered);
    };
    const onData = (chunk: Buffer) => {
      this.#touch();
      buffered = Buffer.concat([buffered, chunk]);
      const sniffed = sniff(buffered);
      if (sniffed.kind !== "more" || buffered.length >= MAX_SNIFF_BYTES) decide(sniffed);
    };
    const timer = setTimeout(() => decide({ kind: "unknown" }), SNIFF_TIMEOUT_MS);
    client.on("data", onData);
    client.once("close", () => {
      if (!decided) {
        decided = true;
        clearTimeout(timer);
        this.#pending--;
      }
    });
    if (buffered.length) onData(Buffer.alloc(0));
  }

  async #resolves(name: string, address: string): Promise<boolean> {
    const cached = this.#dns.get(name);
    let addresses = cached && Date.now() - cached.at < DNS_TTL_MS ? cached.addresses : undefined;
    if (!addresses) {
      try {
        addresses = (await lookup(name, { all: true })).map((entry) => entry.address.toLowerCase());
      } catch {
        addresses = [];
      }
      this.#dns.set(name, { at: Date.now(), addresses });
    }
    return addresses.includes(address);
  }

  async #openTunnel(
    policy: GuardPolicy,
    client: Socket,
    target: { host: string; port: number },
    sniffed: Sniffed,
    first: Buffer,
  ): Promise<void> {
    const name = sniffed.kind === "tls" || sniffed.kind === "http" ? sniffed.name : null;
    const scheme = sniffed.kind === "tls" ? "https" : "http";
    const shown = urlFor(scheme, name ?? target.host, target.port);
    let allowed: boolean;
    if (name && isIP(name) === 0) {
      allowed =
        policy.allowlist.allowsHost(name, target.port) && (await this.#resolves(name, target.host));
    } else {
      // No name, or the name is an address: the address itself must be allowed.
      allowed =
        (name === null || name === target.host) &&
        policy.allowlist.allowsHost(target.host, target.port);
    }
    if (!allowed || this.#policy !== policy || client.destroyed) {
      if (this.#policy === policy) this.#refuse(shown);
      client.destroy();
      return;
    }
    const log =
      sniffed.kind === "http"
        ? new HttpLog({
            request: () => this.#touch(),
            response: (exchange, status) =>
              this.#log(
                exchange.method,
                urlFor("http", name ?? target.host, target.port, exchange.target),
                "http",
                status,
              ),
          })
        : null;
    if (log) this.#logs.add(log);
    const upstream = tcpConnect({ host: upstreamHost(target.host), port: target.port });
    this.#track(upstream);
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy());
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      if (sniffed.kind === "tls") this.#log("CONNECT", shown, "tls", 200);
      if (first.length) {
        log?.fromClient(first);
        upstream.write(first);
      }
      this.#pipe(client, upstream, log);
    });
    upstream.once("error", () => {
      if (sniffed.kind === "tls") this.#log("CONNECT", shown, "tls", "failed");
      client.destroy();
    });
  }

  #pipe(client: Socket, upstream: Socket, log: HttpLog | null): void {
    client.on("data", (chunk: Buffer) => {
      this.#touch();
      log?.fromClient(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      this.#touch();
      log?.fromServer(chunk);
    });
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
    const end = () => {
      log?.closed();
      if (log) this.#logs.delete(log);
      client.destroy();
      upstream.destroy();
    };
    client.once("close", end);
    upstream.once("close", end);
  }
}
