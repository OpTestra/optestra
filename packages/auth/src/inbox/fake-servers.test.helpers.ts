import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Loopback fakes of the Mailpit, Mailosaur and MailSlurp HTTP APIs (only the calls
// the adapters make), shaped after each provider's API docs.

export interface FakeMail {
  id: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  receivedAt: string;
}

export interface SeenRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface FakeServer {
  url: string;
  requests: SeenRequest[];
  mails: FakeMail[];
  /** Adds a mail now, or after `delayMs`. */
  deliver(mail: Omit<FakeMail, "id" | "receivedAt">, delayMs?: number): void;
  /** Makes every request fail with this status (e.g. 500), or undefined to heal. */
  fail(status: number | undefined): void;
  stop(): Promise<void>;
}

type Handler = (
  req: SeenRequest,
  url: URL,
  res: ServerResponse,
  state: { mails: FakeMail[]; inboxes: Map<string, string> },
) => void | Promise<void>;

async function start(handler: Handler): Promise<FakeServer> {
  const requests: SeenRequest[] = [];
  const mails: FakeMail[] = [];
  const inboxes = new Map<string, string>();
  let failing: number | undefined;
  let next = 1;
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const seen = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body };
    requests.push(seen);
    if (failing) {
      res.writeHead(failing, { "content-type": "application/json" }).end('{"error":"failing"}');
      return;
    }
    await handler(seen, new URL(req.url ?? "/", "http://fake"), res, { mails, inboxes });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const timers: NodeJS.Timeout[] = [];
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    mails,
    deliver(mail, delayMs = 0) {
      const add = () =>
        mails.unshift({ ...mail, id: `m${next++}`, receivedAt: new Date().toISOString() });
      if (delayMs) timers.push(setTimeout(add, delayMs));
      else add();
    },
    fail(status) {
      failing = status;
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const json = (res: ServerResponse, status: number, value?: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(value === undefined ? "" : JSON.stringify(value));
};

async function waitFor<T>(find: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found || Date.now() >= end) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Mailpit: /api/v1/info, /api/v1/search?query=to:"a@b", /api/v1/message/<id>. */
export function fakeMailpit(): Promise<FakeServer> {
  return start((_req, url, res, { mails }) => {
    if (url.pathname === "/api/v1/info") return json(res, 200, { Version: "v1.27.0" });
    if (url.pathname === "/api/v1/search") {
      const to = /to:"?([^"\s]+)"?/.exec(url.searchParams.get("query") ?? "")?.[1] ?? "";
      const found = mails.filter((m) => m.to.toLowerCase() === to.toLowerCase());
      return json(res, 200, {
        total: found.length,
        messages: found.map((m) => ({
          ID: m.id,
          From: { Name: "", Address: m.from },
          To: [{ Name: "", Address: m.to }],
          Subject: m.subject,
          Created: m.receivedAt,
          Snippet: m.text.slice(0, 50),
        })),
      });
    }
    const message = /^\/api\/v1\/message\/(.+)$/.exec(url.pathname);
    if (message) {
      const m = mails.find((x) => x.id === decodeURIComponent(message[1] ?? ""));
      if (!m) return json(res, 404, { error: "not found" });
      return json(res, 200, {
        ID: m.id,
        From: { Name: "", Address: m.from },
        To: [{ Name: "", Address: m.to }],
        Subject: m.subject,
        Date: m.receivedAt,
        Text: m.text,
        HTML: m.html ?? "",
      });
    }
    return json(res, 404, { error: "no route" });
  });
}

/** Mailosaur: basic auth "<key>:", POST /api/messages/await, GET /api/servers/<id>. */
export function fakeMailosaur(key: string, serverId: string): Promise<FakeServer> {
  const expected = `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
  return start(async (req, url, res, { mails }) => {
    if (req.headers.authorization !== expected) return json(res, 401, { error: "unauthorized" });
    const server = /^\/api\/servers\/(.+)$/.exec(url.pathname);
    if (server) {
      return server[1] === serverId
        ? json(res, 200, { id: serverId, name: "Tests" })
        : json(res, 404);
    }
    if (url.pathname === "/api/messages/await" && req.method === "POST") {
      if (url.searchParams.get("server") !== serverId) return json(res, 404);
      const criteria = JSON.parse(req.body || "{}") as { sentTo?: string; subject?: string };
      const after = Date.parse(url.searchParams.get("receivedAfter") ?? "") || 0;
      const timeout = Number(url.searchParams.get("timeout") ?? 10_000);
      const m = await waitFor(
        () =>
          mails.find(
            (x) =>
              x.to === criteria.sentTo &&
              Date.parse(x.receivedAt) >= after &&
              (!criteria.subject || x.subject.includes(criteria.subject)),
          ),
        timeout,
      );
      if (!m) return json(res, 204);
      return json(res, 200, {
        id: m.id,
        received: m.receivedAt,
        subject: m.subject,
        from: [{ name: "", email: m.from }],
        to: [{ name: "", email: m.to }],
        text: { body: m.text },
        html: { body: m.html ?? "" },
      });
    }
    return json(res, 404);
  });
}

/** MailSlurp: x-api-key, POST /inboxes, GET /inboxes/<id>, /inboxes/byEmailAddress, /waitForLatestEmail, /user/info. */
export function fakeMailslurp(key: string): Promise<FakeServer> {
  let n = 0;
  return start(async (req, url, res, { mails, inboxes }) => {
    if (req.headers["x-api-key"] !== key) return json(res, 401, { error: "unauthorized" });
    if (url.pathname === "/user/info") return json(res, 200, { id: "user-1" });
    if (url.pathname === "/inboxes" && req.method === "POST") {
      const id = `inbox-${++n}`;
      const address = `${id}@mailslurp.biz`;
      inboxes.set(id, address);
      return json(res, 201, { id, emailAddress: address });
    }
    if (url.pathname === "/inboxes/byEmailAddress") {
      const wanted = url.searchParams.get("emailAddress");
      const id = [...inboxes].find(([, address]) => address === wanted)?.[0];
      return json(res, 200, id ? { inboxId: id, exists: true } : { exists: false });
    }
    const inbox = /^\/inboxes\/(.+)$/.exec(url.pathname);
    if (inbox) {
      const address = inboxes.get(inbox[1] ?? "");
      return address ? json(res, 200, { id: inbox[1], emailAddress: address }) : json(res, 404);
    }
    if (url.pathname === "/waitForLatestEmail") {
      const address = inboxes.get(url.searchParams.get("inboxId") ?? "");
      const since = Date.parse(url.searchParams.get("since") ?? "") || 0;
      const timeout = Number(url.searchParams.get("timeout") ?? 10_000);
      const m = await waitFor(
        () => mails.find((x) => x.to === address && Date.parse(x.receivedAt) >= since),
        timeout,
      );
      if (!m) return json(res, 408, { error: "timeout" });
      return json(res, 200, {
        id: m.id,
        from: m.from,
        to: [m.to],
        subject: m.subject,
        body: m.html ?? m.text,
        isHTML: m.html !== undefined,
        createdAt: m.receivedAt,
      });
    }
    return json(res, 404);
  });
}
