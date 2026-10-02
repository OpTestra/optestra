import { AsyncLocalStorage } from "node:async_hooks";

// Provider limits (PROV-0): how many requests may be in flight, and waiting out a
// rate limit instead of failing. A wait is never a test failure: the time spent
// waiting is reported on its own and doesn't count against a test's time limit
// (see AiWaits).

/** Why a call is waiting. */
export type WaitReason = "rate_limited" | "concurrency";

export interface WaitInfo {
  provider: string;
  model: string;
  reason: WaitReason;
  /** When the call expects to go ahead (ISO); null when unknown (a free slot). */
  resumesAt: string | null;
  /** Plain-English line for the live view. */
  message: string;
}

/**
 * The waits of one unit of work (a test attempt, a draft). Models report every
 * wait to the scope they run in (`aiWaitScope`); deadlines read it, so a test's
 * clock stops while it waits for AI.
 */
export class AiWaits {
  #waited = 0;
  #active = 0;
  #since = 0;
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly onWait?: (info: WaitInfo) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Total time waited, including a wait still going on. */
  get waitedMs(): number {
    return this.#waited + (this.#active > 0 ? this.now() - this.#since : 0);
  }

  /** True while at least one call of this scope is waiting. */
  get waiting(): boolean {
    return this.#active > 0;
  }

  begin(info?: WaitInfo): void {
    if (this.#active++ === 0) this.#since = this.now();
    if (info) this.onWait?.(info);
  }

  end(): void {
    if (this.#active === 0) return;
    if (--this.#active === 0) {
      this.#waited += this.now() - this.#since;
      for (const listener of [...this.#listeners]) listener();
    }
  }

  /** Called each time the last wait ends. Returns the unsubscribe function. */
  onIdle(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** The waits scope the current code runs in, if any. */
export const aiWaitScope = new AsyncLocalStorage<AiWaits>();

/** Runs `fn` with its AI waits reported to `waits`. */
export function withAiWaits<T>(waits: AiWaits, fn: () => T): T {
  return aiWaitScope.run(waits, fn);
}

/**
 * Seconds or an HTTP date from a Retry-After header (RFC 9110), as milliseconds
 * from now. Undefined when absent or unreadable.
 */
export function retryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Retry-After, else a reset time some providers send instead (X-RateLimit-Reset, epoch s or ms). */
export function rateLimitWaitMs(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!headers) return undefined;
  const get = (name: string) =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const after = retryAfterMs(get("retry-after"), now);
  if (after !== undefined) return after;
  const reset = get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) {
    const value = Number(reset);
    const at = value > 1e12 ? value : value * 1000;
    return Math.max(0, at - now);
  }
  return undefined;
}

/** A counting semaphore: `acquire` resolves when a slot is free. FIFO. */
export class Slots {
  #used = 0;
  readonly #queue: Array<() => void> = [];

  constructor(readonly size: number) {}

  get free(): boolean {
    return this.#used < this.size;
  }

  /** Waits for a slot (or the signal). Returns the release function. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    const release = () => {
      const next = this.#queue.shift();
      if (next) next();
      else this.#used--;
    };
    if (this.#used < this.size) {
      this.#used++;
      return Promise.resolve(once(release));
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(once(release));
      };
      const onAbort = () => {
        const at = this.#queue.indexOf(grant);
        if (at >= 0) this.#queue.splice(at, 1);
        reject(signal?.reason ?? new Error("aborted"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(grant);
    });
  }
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

// One limiter per provider account for the whole process: several clients (a
// run's lanes, a bench's phases) share the provider's real limit.
const registry = new Map<string, Slots>();

/** The process-wide slots for `key` (e.g. host, or host + model), created with `size`. */
export function slotsFor(key: string, size: number): Slots {
  const existing = registry.get(key);
  if (existing && existing.size === size) return existing;
  const slots = new Slots(size);
  registry.set(key, slots);
  return slots;
}

/** Forgets every limiter (tests). */
export function resetLimiters(): void {
  registry.clear();
}
