// The device log (EVD-1: logcat for Android). Every line is scrubbed before it is
// kept: nothing unscrubbed is stored, even in memory. The same stream tells the
// session when the app crashed or stopped responding. Pure code: the session
// feeds it the output of `adb logcat`.

const MAX_LINES = 50_000;
/** A launch that never logs "Displayed" (a translucent or trampoline activity) stops counting after this. */
const LAUNCH_TIMEOUT_MS = 3_000;

export interface AppEvent {
  kind: "crashed" | "not_responding";
  package: string;
  /** Position in the log (line count) when it was seen. */
  at: number;
  /** The first line of the exception or ANR reason (scrubbed). */
  detail: string;
}

export class Logcat {
  readonly #redact: (text: string) => string;
  readonly #lines: string[] = [];
  #partial = "";
  #dropped = 0;
  readonly events: AppEvent[] = [];
  #fatalAt: number | null = null;
  #fatalDetail = "";
  /** Activities asked to start and not displayed yet, by component, with when. */
  readonly #launching = new Map<string, number>();
  readonly #now: () => number;
  #lastMark = -1;
  readonly #markWaiters = new Map<number, () => void>();

  constructor(redact: (text: string) => string, now: () => number = Date.now) {
    this.#redact = redact;
    this.#now = now;
  }

  /** Resolves once the log line `mark-<n>` has been read (or after timeoutMs). */
  waitForMark(mark: number, timeoutMs = 2_000): Promise<boolean> {
    if (this.#lastMark >= mark) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#markWaiters.delete(mark);
        resolve(false);
      }, timeoutMs);
      this.#markWaiters.set(mark, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** True while an activity start is on its way to the screen (settle waits for it). */
  launching(): boolean {
    const now = this.#now();
    for (const [component, at] of this.#launching) {
      if (now - at > LAUNCH_TIMEOUT_MS) this.#launching.delete(component);
    }
    return this.#launching.size > 0;
  }

  /** Lines seen so far (including dropped ones). */
  get position(): number {
    return this.#dropped + this.#lines.length;
  }

  feed(chunk: string): void {
    const text = this.#partial + chunk;
    const parts = text.split(/\r?\n/);
    this.#partial = parts.pop() ?? "";
    for (const raw of parts) this.#line(raw);
  }

  #line(raw: string): void {
    const line = this.#redact(raw);
    if (this.#lines.length >= MAX_LINES) {
      this.#lines.shift();
      this.#dropped++;
    }
    this.#lines.push(line);
    const at = this.position;
    const marked = /\buih\s*: mark-(\d+)/.exec(line);
    if (marked?.[1]) {
      const mark = Number(marked[1]);
      this.#lastMark = Math.max(this.#lastMark, mark);
      for (const [waiting, wake] of this.#markWaiters) {
        if (waiting <= mark) {
          this.#markWaiters.delete(waiting);
          wake();
        }
      }
      return;
    }
    // ActivityTaskManager: START u0 {… cmp=com.example/.Main …} … / Displayed com.example/.Main: +312ms
    const start = /\bActivity(?:Task)?Manager\b.*: START u\d+ \{.*\bcmp=([\w.]+\/[\w.$]+)/.exec(
      line,
    );
    if (start?.[1]) {
      this.#launching.set(start[1], this.#now());
      return;
    }
    const displayed =
      /\bActivity(?:Task)?Manager\b.*: (?:Fully drawn|Displayed) ([\w.]+\/[\w.$]+)/.exec(line);
    if (displayed?.[1]) {
      this.#launching.delete(displayed[1]);
      return;
    }
    // AndroidRuntime: FATAL EXCEPTION: main / Process: com.example, PID: 123 / java.lang.X: message
    if (/\bAndroidRuntime\b.*FATAL EXCEPTION/.test(line)) {
      this.#fatalAt = at;
      this.#fatalDetail = "";
      return;
    }
    if (this.#fatalAt !== null && at - this.#fatalAt <= 4) {
      const process = /\bAndroidRuntime\b.*Process: ([\w.]+), PID/.exec(line);
      if (process?.[1]) {
        this.events.push({ kind: "crashed", package: process[1], at, detail: this.#fatalDetail });
        return;
      }
      const exception = /\bAndroidRuntime\b: (\S+(?:Exception|Error)\b.*)$/.exec(line);
      if (exception?.[1]) {
        this.#fatalDetail = exception[1].slice(0, 300);
        const last = this.events[this.events.length - 1];
        if (last && last.kind === "crashed" && last.at >= (this.#fatalAt ?? 0))
          last.detail = this.#fatalDetail;
        return;
      }
    }
    const anr = /\bANR in ([\w.]+)/.exec(line);
    if (anr?.[1]) this.events.push({ kind: "not_responding", package: anr[1], at, detail: "" });
  }

  /** Events about `pkg` after log position `since`. */
  eventsSince(since: number, pkg: string): AppEvent[] {
    return this.events.filter((event) => event.at > since && event.package === pkg);
  }

  /** The kept log, scrubbed, for the logcat.txt artifact. */
  text(): string {
    const head = this.#dropped ? [`(${this.#dropped} earlier lines dropped)`] : [];
    const tail = this.#partial ? [this.#redact(this.#partial)] : [];
    return [...head, ...this.#lines, ...tail].join("\n");
  }
}
