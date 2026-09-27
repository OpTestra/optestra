import { connect, type Socket } from "node:net";

// The host half of the on-device driver's protocol (driver/…/Server.kt): one JSON
// object per line, each request answered in order. The only address it ever
// connects to is 127.0.0.1, at the port `adb forward` opened to the driver's
// local socket; the first message carries the session's random token.

export const DRIVER_HOST = "127.0.0.1";
export const DRIVER_PACKAGE = "dev.uiharness.driver";

export type Bounds = [number, number, number, number];

export interface DriverWindow {
  id: number;
  type: "application" | "input_method" | "system" | "accessibility_overlay" | "divider" | "other";
  layer: number;
  active: boolean;
  focused: boolean;
  title: string | null;
  package: string | null;
  /** Class of the window's latest state change: its Activity, or a dialog class. */
  cls: string | null;
  bounds: Bounds;
}

export interface DriverNode {
  id: number;
  parent: number;
  window: number;
  depth: number;
  cls: string;
  pkg: string;
  bounds: Bounds;
  rid?: string;
  text?: string;
  desc?: string;
  hint?: string;
  error?: string;
  pane?: string;
  tooltip?: string;
  stateDesc?: string;
  flags: string[];
  inputType?: number;
  range?: { type: number; min: number; max: number; current: number };
  collection?: { rows: number; cols: number };
  item?: { row: number; col: number };
  actions?: string[];
  labeledBy?: number;
}

export interface Dump {
  windows: DriverWindow[];
  nodes: DriverNode[];
  truncated: boolean;
  /** `com.example/.MainActivity`, or null when unknown. */
  activity: string | null;
  rotation: number;
}

export interface Hello {
  sdk: number;
  release: string;
  model: string;
  width: number;
  height: number;
  density: number;
}

export class DriverError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = "DriverError";
    this.code = code;
  }
}

interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class DriverClient {
  readonly #socket: Socket;
  readonly #pending = new Map<number, Pending>();
  #buffer = "";
  #next = 1;
  #closed: Error | null = null;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#onData(chunk));
    socket.on("error", (error) => this.#fail(new DriverError("driver_lost", error.message)));
    socket.on("close", () =>
      this.#fail(new DriverError("driver_lost", "The driver connection closed.")),
    );
  }

  /** Connects to the forwarded port and authenticates. Throws DriverError. */
  static async connect(
    port: number,
    token: string,
    timeoutMs = 5_000,
  ): Promise<{ client: DriverClient; hello: Hello }> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ host: DRIVER_HOST, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new DriverError("driver_unreachable", "Timed out connecting to the driver."));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (error) => {
        clearTimeout(timer);
        reject(new DriverError("driver_unreachable", error.message));
      });
    });
    const client = new DriverClient(socket);
    const hello = (await client.call("hello", { token }, timeoutMs)) as unknown as Hello;
    return { client, hello };
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  /** Sends one command. Rejects with DriverError (driver-side refusals keep their code). */
  call(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new DriverError("driver_timeout", `The driver did not answer "${cmd}" in time.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(`${JSON.stringify({ ...args, id, cmd })}\n`);
    });
  }

  async dump(): Promise<Dump> {
    return (await this.call("dump")) as unknown as Dump;
  }

  async quit(): Promise<void> {
    if (this.#closed) return;
    await this.call("quit", {}, 2_000).catch(() => {});
    this.#socket.destroy();
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.#fail(new DriverError("driver_lost", "The driver sent something that isn't JSON."));
        return;
      }
      const pending = this.#pending.get(Number(message.id));
      if (!pending) continue;
      this.#pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (message.ok === true) pending.resolve(message);
      else pending.reject(new DriverError(String(message.error ?? "driver_error")));
    }
  }

  #fail(error: DriverError): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
