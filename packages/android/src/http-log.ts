// Reads plain HTTP/1.x off both directions of one connection, to log each
// request (method, target, status) and to know when requests are in flight
// (settle). Bodies are skipped, never kept. Pure code: the guard feeds it bytes.
// Anything it can't follow (a protocol switch, an oversized header) makes it
// stop logging that connection; the bytes still flow.

const MAX_HEAD = 64 * 1024;

export interface HttpExchange {
  method: string;
  /** Origin-form target (`/api/projects?x=1`) or absolute form, as sent. */
  target: string;
  host: string | null;
  startedAt: number;
}

export interface HttpLogEvents {
  request(exchange: HttpExchange): void;
  response(exchange: HttpExchange, status: number): void;
}

type Body =
  | { kind: "none" }
  | { kind: "length"; left: number }
  | { kind: "chunked"; state: "size" | "data" | "data-end" | "trailer"; left: number }
  | { kind: "until-close" };

class Direction {
  buffer = Buffer.alloc(0);
  body: Body = { kind: "none" };
  inBody = false;
}

function headerValue(head: string, name: string): string | null {
  const match = new RegExp(`\\r\\n${name}:[ \\t]*([^\\r\\n]*)`, "i").exec(head);
  return match?.[1]?.trim() ?? null;
}

function bodyOf(head: string, isResponse: boolean, status: number, method: string): Body {
  if (
    isResponse &&
    (method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200))
  ) {
    return { kind: "none" };
  }
  if (/chunked/i.test(headerValue(head, "transfer-encoding") ?? "")) {
    return { kind: "chunked", state: "size", left: 0 };
  }
  const length = headerValue(head, "content-length");
  if (length !== null && /^\d+$/.test(length)) {
    return Number(length) === 0 ? { kind: "none" } : { kind: "length", left: Number(length) };
  }
  return isResponse ? { kind: "until-close" } : { kind: "none" };
}

export class HttpLog {
  readonly #events: HttpLogEvents;
  readonly #client = new Direction();
  readonly #server = new Direction();
  readonly #pending: HttpExchange[] = [];
  #broken = false;
  readonly #now: () => number;

  constructor(events: HttpLogEvents, now: () => number = Date.now) {
    this.#events = events;
    this.#now = now;
  }

  /** Requests sent whose response hasn't fully arrived. */
  get inflight(): number {
    return this.#broken ? 0 : this.#pending.length;
  }

  fromClient(chunk: Uint8Array): void {
    this.#feed(this.#client, chunk, false);
  }

  fromServer(chunk: Uint8Array): void {
    this.#feed(this.#server, chunk, true);
  }

  /** The connection closed: a response that runs until close is complete now. */
  closed(): void {
    if (this.#server.inBody && this.#server.body.kind === "until-close") this.#finishResponse();
    this.#pending.length = 0;
  }

  #feed(direction: Direction, chunk: Uint8Array, isResponse: boolean): void {
    if (this.#broken) return;
    direction.buffer = direction.buffer.length
      ? Buffer.concat([direction.buffer, chunk])
      : Buffer.from(chunk);
    for (;;) {
      if (direction.inBody) {
        if (!this.#consumeBody(direction, isResponse)) return;
        continue;
      }
      const end = direction.buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (direction.buffer.length > MAX_HEAD) this.#broken = true;
        return;
      }
      const head = `\r\n${direction.buffer.subarray(0, end + 2).toString("latin1")}`;
      direction.buffer = direction.buffer.subarray(end + 4);
      const firstLine = head.slice(2, head.indexOf("\r\n", 2));
      if (isResponse) {
        const status = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(firstLine)?.[1] ?? Number.NaN);
        const exchange = this.#pending[0];
        if (Number.isNaN(status) || !exchange) {
          this.#broken = true;
          return;
        }
        if (status === 101) {
          this.#broken = true; // Switching protocols (web sockets, h2c): stop following it.
          this.#events.response(exchange, status);
          return;
        }
        if (status >= 100 && status < 200) continue; // 100 Continue: the real response follows.
        this.#events.response(exchange, status);
        direction.body = bodyOf(head, true, status, exchange.method);
        if (direction.body.kind === "none") this.#pending.shift();
        else direction.inBody = true;
      } else {
        const match = /^([A-Z]+) (\S+) HTTP\/\d(?:\.\d)?$/.exec(firstLine);
        if (!match) {
          this.#broken = true;
          return;
        }
        const exchange: HttpExchange = {
          method: match[1] as string,
          target: match[2] as string,
          host: headerValue(head, "host"),
          startedAt: this.#now(),
        };
        this.#pending.push(exchange);
        this.#events.request(exchange);
        direction.body = bodyOf(head, false, 0, exchange.method);
        direction.inBody = direction.body.kind !== "none";
      }
    }
  }

  /** Skips body bytes. Returns false when it needs more data. */
  #consumeBody(direction: Direction, isResponse: boolean): boolean {
    const body = direction.body;
    const done = () => {
      direction.inBody = false;
      direction.body = { kind: "none" };
      if (isResponse) this.#pending.shift();
    };
    switch (body.kind) {
      case "none":
        done();
        return true;
      case "until-close":
        direction.buffer = Buffer.alloc(0);
        return false;
      case "length": {
        const take = Math.min(body.left, direction.buffer.length);
        body.left -= take;
        direction.buffer = direction.buffer.subarray(take);
        if (body.left > 0) return false;
        done();
        return true;
      }
      case "chunked": {
        for (;;) {
          if (body.state === "size") {
            const end = direction.buffer.indexOf("\r\n");
            if (end < 0) return false;
            const size = Number.parseInt(direction.buffer.subarray(0, end).toString("latin1"), 16);
            direction.buffer = direction.buffer.subarray(end + 2);
            if (Number.isNaN(size)) {
              this.#broken = true;
              return false;
            }
            if (size === 0) body.state = "trailer";
            else {
              body.state = "data";
              body.left = size;
            }
          } else if (body.state === "data") {
            const take = Math.min(body.left, direction.buffer.length);
            body.left -= take;
            direction.buffer = direction.buffer.subarray(take);
            if (body.left > 0) return false;
            body.state = "data-end";
          } else if (body.state === "data-end") {
            if (direction.buffer.length < 2) return false;
            direction.buffer = direction.buffer.subarray(2);
            body.state = "size";
          } else {
            // Trailer section: header lines until an empty line.
            const end = direction.buffer.indexOf("\r\n");
            if (end < 0) return false;
            direction.buffer = direction.buffer.subarray(end + 2);
            if (end === 0) {
              done();
              return true;
            }
          }
        }
      }
    }
  }

  #finishResponse(): void {
    this.#server.inBody = false;
    this.#pending.shift();
  }
}
