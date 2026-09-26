import type { InboxHttpResult } from "./transport.js";
import { CLOCK_SKEW_MS, type InboxFailure, type InboxMessage } from "./types.js";

export function failure(
  reason: InboxFailure["reason"],
  message: string,
  fix?: string,
): InboxFailure {
  return { ok: false, reason, message, ...(fix && { fix }) };
}

/** Maps a transport error or a non-2xx status to a typed failure. */
export function httpFailure(
  provider: string,
  result: InboxHttpResult,
  keyHint?: string,
): InboxFailure {
  if (result.kind === "error") {
    if (result.reason === "aborted") return failure("aborted", "cancelled");
    if (result.reason === "timeout")
      return failure("unavailable", `${provider}: ${result.message}`);
    return failure(
      "unavailable",
      `${provider}: ${result.message}`,
      result.reason === "blocked" ? undefined : `Check that ${provider} is running and reachable.`,
    );
  }
  if (result.status === 401 || result.status === 403) {
    return failure(
      "unauthorized",
      `${provider} refused the API key (HTTP ${result.status}).`,
      keyHint ? `Check ${keyHint}.` : undefined,
    );
  }
  if (result.status >= 500 || result.status === 429) {
    return failure(
      "unavailable",
      `${provider} is failing (HTTP ${result.status}); try again later.`,
    );
  }
  return failure("bad_response", `${provider} answered HTTP ${result.status}.`);
}

export const str = (value: unknown): string => (typeof value === "string" ? value : "");
export const obj = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function receivedSince(message: Pick<InboxMessage, "receivedAt">, since: Date): boolean {
  const at = Date.parse(message.receivedAt);
  return Number.isNaN(at) || at >= since.getTime() - CLOCK_SKEW_MS;
}

export function subjectMatches(subject: string, contains: string | undefined): boolean {
  return !contains || subject.toLowerCase().includes(contains.toLowerCase());
}

export const sameAddress = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** Waits `ms`, or less when the signal aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A local part from a hint: letters, digits, dots, dashes and plus only. */
export function localPart(hint: string | undefined, random: () => string): string {
  const clean = (hint ?? "")
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9.+-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 40);
  return clean || `test-${random()}`;
}
