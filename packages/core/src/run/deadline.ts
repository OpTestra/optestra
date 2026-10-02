import { AiWaits, aiWaitScope } from "@optestra/models";

// A test's time limit that stops while its AI calls wait for a provider (a rate
// limit's Retry-After, or no free slot). A provider's quota is never the test's
// fault, so a wait must never turn into a timeout or a wrong verdict.

export class Deadline {
  readonly #started: number;
  readonly #waitedAtStart: number;

  constructor(
    readonly limitMs: number,
    /** The waits to leave out. Default: the scope this code runs in, else none. */
    readonly waits: AiWaits = aiWaitScope.getStore() ?? new AiWaits(),
    private readonly now: () => number = Date.now,
  ) {
    this.#started = now();
    this.#waitedAtStart = waits.waitedMs;
  }

  /** Time used so far, AI waits left out. */
  get usedMs(): number {
    return this.now() - this.#started - (this.waits.waitedMs - this.#waitedAtStart);
  }

  /** Time left (never below 0). Doesn't drop while a wait is going on. */
  get remainingMs(): number {
    return Math.max(0, this.limitMs - this.usedMs);
  }

  get expired(): boolean {
    return !this.waits.waiting && this.remainingMs === 0;
  }

  /**
   * Aborts `controller` when the time is up, counting only time not spent
   * waiting for AI. Returns the function that cancels the timer.
   */
  arm(controller: AbortController, reason: () => unknown = () => new Error("timeout")): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const check = () => {
      timer = undefined;
      if (controller.signal.aborted) return;
      if (this.waits.waiting) {
        // Look again once the wait is over.
        unsubscribe ??= this.waits.onIdle(() => {
          unsubscribe?.();
          unsubscribe = undefined;
          schedule();
        });
        return;
      }
      if (this.remainingMs === 0) controller.abort(reason());
      else schedule();
    };
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(check, Math.max(1, this.remainingMs));
    };
    schedule();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
    };
  }

  /** A signal that aborts when the time is up (AI waits left out). */
  signal(reason?: () => unknown): { signal: AbortSignal; clear: () => void } {
    const controller = new AbortController();
    const clear = this.arm(controller, reason);
    return { signal: controller.signal, clear };
  }
}
