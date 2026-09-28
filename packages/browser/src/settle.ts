import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserContext, Frame, Request } from "playwright";
import type { RequestSummary, SettleResult } from "./types.js";

// Settle (LRN-4 foundation): the page is settled when no document/fetch/XHR
// request is in flight, the network and the DOM have both been quiet for a
// window, and nothing is marked aria-busy. The window counts from the start of
// the settle at the earliest: an action's request can reach us a few ms after
// the action returns, so quiet before the action proves nothing. The DOM side is reported by a small
// script in every frame through a binding, so settling adds no page calls.

const TRACKED = new Set(["document", "fetch", "xhr"]);
const POLL_MS = 25;
const REPORT_MS = 40;

export const DEFAULT_SETTLE = { timeoutMs: 10_000, quietMs: 300 };

/** The script added to every frame. `binding` is the name of the exposed binding. */
export function mutationScript(binding: string): string {
  return `(() => {
  const report = globalThis[${JSON.stringify(binding)}];
  if (typeof report !== "function") return;
  let pending = false;
  const send = () => {
    pending = false;
    try { report(Boolean(document.querySelector('[aria-busy="true"]'))); } catch {}
  };
  const schedule = () => { if (!pending) { pending = true; setTimeout(send, ${REPORT_MS}); } };
  new MutationObserver(schedule).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  schedule();
})();`;
}

interface Tracked {
  request: Request;
  summary: RequestSummary;
  startedAt: number;
}

/** Watches a context's traffic and DOM activity. */
export class ActivityTracker {
  readonly #inflight = new Set<Request>();
  readonly #busy = new Map<Frame, boolean>();
  readonly #log: Tracked[] = [];
  readonly #byRequest = new Map<Request, Tracked>();
  #lastNetwork = Date.now();
  #lastMutation = Date.now();

  constructor(
    context: BrowserContext,
    private readonly redact: (text: string) => string,
    private readonly isRefused: (request: Request) => boolean,
  ) {
    context.on("request", (request) => {
      const tracked: Tracked = {
        request,
        startedAt: Date.now(),
        summary: {
          method: request.method(),
          url: this.redact(request.url()),
          resourceType: request.resourceType(),
          status: "pending",
        },
      };
      this.#log.push(tracked);
      this.#byRequest.set(request, tracked);
      if (TRACKED.has(request.resourceType())) this.#inflight.add(request);
      this.#lastNetwork = Date.now();
    });
    context.on("response", (response) => {
      const tracked = this.#byRequest.get(response.request());
      if (tracked) tracked.summary.status = response.status();
    });
    const done = (request: Request, failed: boolean) => {
      this.#inflight.delete(request);
      this.#lastNetwork = Date.now();
      const tracked = this.#byRequest.get(request);
      if (!tracked || !failed) return;
      if (this.isRefused(request)) {
        tracked.summary.status = "refused";
        return;
      }
      tracked.summary.status = "failed";
      const failure = request.failure()?.errorText;
      if (failure) tracked.summary.failure = this.redact(failure);
    };
    context.on("requestfinished", (request) => done(request, false));
    context.on("requestfailed", (request) => done(request, true));
  }

  /** Called by the binding: a frame's DOM changed. */
  mutated(frame: Frame | undefined, busy: boolean): void {
    this.#lastMutation = Date.now();
    if (frame) this.#busy.set(frame, busy);
  }

  frameGone(frame: Frame): void {
    this.#busy.delete(frame);
  }

  /** Document, fetch and XHR requests in flight now. */
  get inflight(): number {
    return this.#inflight.size;
  }

  /** A position in the request log. */
  mark(): number {
    return this.#log.length;
  }

  requestsSince(mark: number): RequestSummary[] {
    return this.#log.slice(mark).map((tracked) => ({ ...tracked.summary }));
  }

  /**
   * `since` (epoch ms, default now) is where the quiet window may start at the
   * earliest: settling a page later, after an action that ended on its effect,
   * counts the quiet from when that action finished, never from before it.
   */
  async settle(
    options: { timeoutMs?: number; quietMs?: number; since?: number } = {},
  ): Promise<SettleResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SETTLE.timeoutMs;
    const quietMs = options.quietMs ?? DEFAULT_SETTLE.quietMs;
    const start = Date.now();
    const from = Math.min(start, options.since ?? start);
    const waitedFor = { network: 0, dom: 0, busy: 0 };
    let previous = start;
    for (;;) {
      const now = Date.now();
      const step = now - previous;
      previous = now;
      const network =
        this.#inflight.size === 0 && now - Math.max(this.#lastNetwork, from) >= quietMs;
      const dom = now - Math.max(this.#lastMutation, from) >= quietMs;
      const busy = [...this.#busy.entries()].some(([frame, value]) => value && !frame.isDetached());
      if (!network) waitedFor.network += step;
      if (!dom) waitedFor.dom += step;
      if (busy) waitedFor.busy += step;
      if (network && dom && !busy) {
        return { settledMs: now - start, timedOut: false, waitedFor, inflight: 0 };
      }
      if (now - start >= timeoutMs) {
        return { settledMs: now - start, timedOut: true, waitedFor, inflight: this.#inflight.size };
      }
      await sleep(POLL_MS);
    }
  }
}
