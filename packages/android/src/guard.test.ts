import { createServer, request, type Server } from "node:http";
import { type AddressInfo, connect, createServer as netServer, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Allowlist } from "@optestra/browser";
import { afterEach, describe, expect, it } from "vitest";
import { NetworkGuard, parseConnectTarget } from "./guard.js";
import { HttpLog } from "./http-log.js";
import { sniff, stripPort } from "./sniff.js";
import type { AndroidRefusal, RequestSummary } from "./types.js";

// The network guard (SAF-1, MOB-7) as the emulator uses it: plain HTTP arrives
// as absolute-form proxy requests; everything else as CONNECT <ip>:<port>, where
// loopback stands for the emulator's host alias 10.0.2.2.

/** The bytes of a real TLS ClientHello for `servername`. */
function clientHello(servername: string | undefined): Promise<Buffer> {
  return new Promise((resolve) => {
    const server = netServer((socket) => {
      socket.once("data", (data) => {
        resolve(data);
        socket.destroy();
        server.close();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const tls = tlsConnect({
        host: "127.0.0.1",
        port,
        ...(servername ? { servername } : {}),
        rejectUnauthorized: false,
      });
      tls.on("error", () => {});
    });
  });
}

describe("sniffing the first message", () => {
  it("reads the server name from a TLS ClientHello", async () => {
    expect(sniff(await clientHello("api.example.com"))).toEqual({
      kind: "tls",
      name: "api.example.com",
    });
    expect(sniff(await clientHello(undefined))).toEqual({ kind: "tls", name: null });
  });

  it("reads the Host header of plain HTTP, waits for more, and gives up on other protocols", () => {
    const http = Buffer.from("GET /x HTTP/1.1\r\nHost: 10.0.2.2:4180\r\n\r\n");
    expect(sniff(http)).toEqual({ kind: "http", name: "10.0.2.2" });
    expect(sniff(http.subarray(0, 12))).toEqual({ kind: "more" });
    expect(sniff(Buffer.from("GE"))).toEqual({ kind: "more" });
    expect(sniff(Buffer.from("SSH-2.0-OpenSSH\r\n"))).toEqual({ kind: "unknown" });
    expect(stripPort("[::1]:80")).toBe("::1");
    expect(stripPort("example.com:8080")).toBe("example.com");
  });

  it("parses CONNECT targets", () => {
    expect(parseConnectTarget("142.250.1.1:443")).toEqual({ host: "142.250.1.1", port: 443 });
    expect(parseConnectTarget("[2001:db8::1]:443")).toEqual({ host: "2001:db8::1", port: 443 });
    expect(parseConnectTarget("nope")).toBeNull();
    expect(parseConnectTarget("1.2.3.4:99999")).toBeNull();
  });
});

describe("the HTTP log", () => {
  it("follows keep-alive requests with length, chunked and empty bodies", () => {
    const seen: string[] = [];
    const log = new HttpLog({
      request: (e) => seen.push(`> ${e.method} ${e.target}`),
      response: (e, status) => seen.push(`< ${e.method} ${e.target} ${status}`),
    });
    log.fromClient(Buffer.from("POST /login HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\n\r\nab"));
    expect(log.inflight).toBe(1);
    log.fromClient(Buffer.from("cdeGET /api HTTP/1.1\r\nHost: h\r\n\r\nHEAD /h HTTP/1.1\r\n\r\n"));
    expect(log.inflight).toBe(3);
    log.fromServer(Buffer.from("HTTP/1.1 303 See Other\r\nContent-Length: 0\r\n\r\n"));
    log.fromServer(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nab"));
    expect(log.inflight).toBe(2);
    log.fromServer(Buffer.from("cd\r\n0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n"));
    expect(log.inflight).toBe(0);
    expect(seen).toEqual([
      "> POST /login",
      "> GET /api",
      "> HEAD /h",
      "< POST /login 303",
      "< GET /api 200",
      "< HEAD /h 200",
    ]);
  });

  it("stops following a connection it can't read", () => {
    const log = new HttpLog({ request: () => {}, response: () => {} });
    log.fromClient(Buffer.from("GET / HTTP/1.1\r\n\r\n"));
    log.fromServer(Buffer.from("garbage\r\n\r\n"));
    expect(log.inflight).toBe(0);
  });
});

describe("NetworkGuard", () => {
  let guard: NetworkGuard;
  let server: Server | undefined;
  afterEach(async () => {
    await guard?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function setup(allowed: string[]) {
    server = createServer((req, res) => res.end(`hello ${req.method} ${req.url}`));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    guard = await NetworkGuard.start();
    const refused: AndroidRefusal[] = [];
    const requests: RequestSummary[] = [];
    guard.setPolicy({
      allowlist: new Allowlist(allowed.map((a) => a.replace("PORT", String(port)))),
      onRefused: (r) => refused.push(r),
      onRequest: (r) => requests.push(r),
    });
    const guardPort = Number(new URL(guard.url).port);
    return { port, guardPort, refused, requests };
  }

  /** CONNECT through the guard, then send `first` and read the reply. */
  function tunnel(guardPort: number, target: string, first: string | Buffer): Promise<string> {
    return new Promise((resolve) => {
      const socket: Socket = connect(guardPort, "127.0.0.1", () => {
        socket.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`);
      });
      let data = "";
      let established = false;
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (!established && data.includes("\r\n\r\n")) {
          established = true;
          data = "";
          socket.write(first);
        }
      });
      socket.on("close", () => resolve(data));
      socket.on("error", () => resolve(data));
      setTimeout(() => socket.destroy(), 1_500);
    });
  }

  it("lets an allowed host-alias port through (to this machine) and logs its requests", async () => {
    const { port, guardPort, requests, refused } = await setup(["10.0.2.2:PORT"]);
    const reply = await tunnel(
      guardPort,
      `127.0.0.1:${port}`,
      `GET /api/projects HTTP/1.1\r\nHost: 10.0.2.2:${port}\r\nConnection: close\r\n\r\n`,
    );
    expect(reply).toContain("hello GET /api/projects");
    expect(requests).toEqual([
      {
        method: "GET",
        url: `http://10.0.2.2:${port}/api/projects`,
        resourceType: "http",
        status: 200,
      },
    ]);
    expect(refused).toEqual([]);
  });

  it("refuses other ports, other hosts, forged names and everything without a policy", async () => {
    const { port, guardPort, refused } = await setup(["10.0.2.2:1", "localhost"]);
    expect(
      await tunnel(
        guardPort,
        `127.0.0.1:${port}`,
        `GET / HTTP/1.1\r\nHost: 10.0.2.2:${port}\r\n\r\n`,
      ),
    ).toBe("");
    // An allowed name the address doesn't belong to: 10.0.2.2 is not one of localhost's addresses.
    const forged = await tunnel(
      guardPort,
      `127.0.0.1:${port}`,
      `GET / HTTP/1.1\r\nHost: localhost\r\n\r\n`,
    );
    expect(forged).toBe("");
    const hello = await clientHello("api.example.com");
    const tls = await tunnel(guardPort, "93.184.215.14:443", hello);
    expect(tls).toBe("");
    expect(refused.map((r) => [r.type, r.url])).toEqual([
      ["proxy", `http://10.0.2.2:${port}/`],
      ["proxy", `http://localhost:${port}/`],
      ["proxy", "https://api.example.com/"],
    ]);
    guard.setPolicy(null);
    const none = await tunnel(guardPort, `127.0.0.1:${port}`, "GET / HTTP/1.1\r\n\r\n");
    expect(none).toBe("");
    expect(refused).toHaveLength(3);
  });

  it("forwards plain proxy requests only to allowed hosts", async () => {
    const { port, guardPort, refused, requests } = await setup(["10.0.2.2:PORT"]);
    const get = (url: string) =>
      new Promise<number>((resolve) => {
        const req = request(
          { host: "127.0.0.1", port: guardPort, path: url, headers: { host: new URL(url).host } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", () => resolve(0));
        req.end();
      });
    expect(await get(`http://10.0.2.2:${port}/pricing`)).toBe(200);
    expect(await get("http://tracker.example.com/pixel")).toBe(403);
    expect(requests).toEqual([
      { method: "GET", url: `http://10.0.2.2:${port}/pricing`, resourceType: "http", status: 200 },
    ]);
    expect(refused.map((r) => r.url)).toEqual(["http://tracker.example.com/pixel"]);
  });
});
