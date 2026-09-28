import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, BrowserContextOptions, ConsoleMessage, Page } from "playwright";
import type { EvidenceFile, EvidenceOptions } from "./types.js";
import { readZip, writeZip, type ZipEntry } from "./zip.js";

// Evidence capture (EVD-1 foundation). Everything written goes through `redact`
// first. The trace is recorded in chunks: a secret fill stops the current chunk
// and starts a new one afterwards, so the fill itself is never traced (SEC-6).
// At close the chunks are merged into one trace.zip (one trace per chunk, which
// the trace viewer shows in order) and every text entry is scrubbed.

const HIDDEN_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization"]);

export class Evidence {
  readonly #options: EvidenceOptions;
  readonly #dir: string;
  readonly #redact: (text: string) => string;
  readonly #console: string[] = [];
  readonly #chunks: string[] = [];
  #context: BrowserContext | undefined;
  #tracing = false;
  #paused = false;
  #pages = new Set<Page>();

  constructor(options: EvidenceOptions, dir: string, redact: (text: string) => string) {
    this.#options = options;
    this.#dir = dir;
    this.#redact = redact;
  }

  contextOptions(): BrowserContextOptions {
    const options: BrowserContextOptions = {};
    if (this.#options.video) options.recordVideo = { dir: join(this.#dir, "video-raw") };
    if (this.#options.network) {
      options.recordHar = {
        path: join(this.#dir, "network-raw.har"),
        content: "omit",
        mode: "full",
      };
    }
    return options;
  }

  async start(context: BrowserContext): Promise<void> {
    this.#context = context;
    if (!this.#options.trace) return;
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    await context.tracing.startChunk();
    this.#tracing = true;
  }

  watch(page: Page): void {
    if (this.#pages.has(page)) return;
    this.#pages.add(page);
    if (!this.#options.console) return;
    page.on("console", (message: ConsoleMessage) => {
      const { url, lineNumber } = message.location();
      const where = url ? ` (${url}:${lineNumber})` : "";
      this.#console.push(
        `${new Date().toISOString()} [${message.type()}] ${message.text()}${where}`,
      );
    });
    page.on("pageerror", (error) => {
      this.#console.push(`${new Date().toISOString()} [pageerror] ${error.message}`);
    });
  }

  /** Stops tracing before a secret is typed. */
  async pauseTrace(): Promise<void> {
    if (!this.#tracing || this.#paused || !this.#context) return;
    const path = join(this.#dir, `trace-chunk-${this.#chunks.length}.zip`);
    await this.#context.tracing.stopChunk({ path });
    this.#chunks.push(path);
    this.#paused = true;
  }

  async resumeTrace(): Promise<void> {
    if (!this.#tracing || !this.#paused || !this.#context) return;
    await this.#context.tracing.startChunk();
    this.#paused = false;
  }

  /**
   * Call before the context closes: ends tracing. `discardTrace`: the trace
   * isn't wanted after all (a clean pass): its chunks are dropped unread.
   */
  async stop(options: { discardTrace?: boolean } = {}): Promise<void> {
    if (!this.#tracing || !this.#context) return;
    try {
      if (!this.#paused) {
        if (options.discardTrace) await this.#context.tracing.stopChunk();
        else {
          const path = join(this.#dir, `trace-chunk-${this.#chunks.length}.zip`);
          await this.#context.tracing.stopChunk({ path });
          this.#chunks.push(path);
        }
      }
      await this.#context.tracing.stop();
    } catch {
      // The context is already gone (crash): keep the chunks we have.
    }
    this.#tracing = false;
    if (options.discardTrace) {
      for (const chunk of this.#chunks) rmSync(chunk, { force: true });
      this.#chunks.length = 0;
    }
  }

  /**
   * Call after the context closed: writes the scrubbed files. `discardNetwork`:
   * the HAR isn't wanted after all: it is deleted unread.
   */
  async finish(
    videoPath: string | undefined,
    options: { discardNetwork?: boolean } = {},
  ): Promise<EvidenceFile[]> {
    const files: EvidenceFile[] = [];
    if (this.#options.trace && this.#chunks.length > 0) {
      const path = join(this.#dir, "trace.zip");
      writeFileSync(path, this.#mergeTrace());
      for (const chunk of this.#chunks) rmSync(chunk, { force: true });
      files.push({
        kind: "trace",
        file: "trace",
        path,
        contentType: "application/zip",
        scrubbed: true,
      });
    }
    if (this.#options.console) {
      const path = join(this.#dir, "console.log");
      const text = this.#console.map((line) => this.#redact(line)).join("\n");
      writeFileSync(path, text === "" ? "" : `${text}\n`);
      files.push({
        kind: "console",
        file: "console",
        path,
        contentType: "text/plain",
        scrubbed: true,
      });
    }
    const rawHar = join(this.#dir, "network-raw.har");
    if (options.discardNetwork) rmSync(rawHar, { force: true });
    else if (this.#options.network && existsSync(rawHar)) {
      const path = join(this.#dir, "network.har");
      writeFileSync(path, this.#scrubHar(readFileSync(rawHar, "utf8")));
      rmSync(rawHar, { force: true });
      files.push({
        kind: "network",
        file: "network",
        path,
        contentType: "application/json",
        scrubbed: true,
      });
    }
    if (this.#options.video && videoPath && existsSync(videoPath)) {
      const path = join(this.#dir, "video.webm");
      renameSync(videoPath, path);
      rmSync(join(this.#dir, "video-raw"), { recursive: true, force: true });
      files.push({ kind: "video", file: "video", path, contentType: "video/webm", scrubbed: true });
    }
    return files;
  }

  #scrubText(data: Uint8Array): Uint8Array {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      return data; // binary (screenshots)
    }
    return new TextEncoder().encode(this.#redact(text));
  }

  #mergeTrace(): Uint8Array {
    const merged = new Map<string, Uint8Array>();
    const single = this.#chunks.length === 1;
    this.#chunks.forEach((chunk, index) => {
      const entries: ZipEntry[] = readZip(readFileSync(chunk));
      for (const entry of entries) {
        // trace.trace / trace.network / trace.stacks → <n>-trace.*: one trace per chunk.
        const name =
          !single && /^trace\.\w+$/.test(entry.name) ? `${index}-${entry.name}` : entry.name;
        merged.set(name, this.#scrubText(entry.data));
      }
    });
    return writeZip([...merged].map(([name, data]) => ({ name, data })));
  }

  #scrubHar(text: string): string {
    const har = JSON.parse(text) as {
      log?: {
        entries?: Array<{
          request?: {
            postData?: unknown;
            headers?: Array<{ name: string; value: string }>;
            cookies?: unknown[];
          };
          response?: { headers?: Array<{ name: string; value: string }>; cookies?: unknown[] };
        }>;
      };
    };
    const hide = (headers?: Array<{ name: string; value: string }>) => {
      for (const header of headers ?? []) {
        if (HIDDEN_HEADERS.has(header.name.toLowerCase())) header.value = "[removed]";
      }
    };
    for (const entry of har.log?.entries ?? []) {
      if (entry.request) {
        delete entry.request.postData; // request bodies can hold secrets (SEC-6)
        hide(entry.request.headers);
        entry.request.cookies = [];
      }
      if (entry.response) {
        hide(entry.response.headers);
        entry.response.cookies = [];
      }
    }
    return this.#redact(JSON.stringify(har, null, 2));
  }
}
