import type { Redactor } from "@optestra/config/node";
import { APICallError, NoObjectGeneratedError } from "ai";
import { BlockedHostError } from "./transport.js";
import type { AttemptOutcome } from "./types.js";

export interface ClassifiedError {
  outcome: AttemptOutcome;
  status?: number;
  message: string;
}

/** Maps any error from a provider call to an attempt outcome, with a redacted message. */
export function classifyError(
  error: unknown,
  redactor: Redactor,
  flags: { timedOut: boolean; aborted: boolean },
): ClassifiedError {
  const redact = (text: string) => redactor.redact(text).slice(0, 1000);
  if (flags.aborted) return { outcome: "aborted", message: "The caller cancelled the request." };
  if (flags.timedOut)
    return { outcome: "timeout", message: "The provider did not answer in time." };
  if (NoObjectGeneratedError.isInstance(error)) {
    const cause = error.cause instanceof Error ? error.cause.message : error.message;
    return {
      outcome: "invalid_output",
      message: redact(`The reply did not match the output schema: ${cause}`),
    };
  }
  if (error instanceof BlockedHostError)
    return { outcome: "blocked_host", message: redact(error.message) };
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    const body =
      typeof error.responseBody === "string" && error.responseBody ? `: ${error.responseBody}` : "";
    const message = redact(`${error.message}${body}`);
    if (status === undefined) return { outcome: "network_error", message };
    const outcome: AttemptOutcome =
      status === 401 || status === 403
        ? "auth_failed"
        : status === 429
          ? "rate_limited"
          : status === 408
            ? "timeout"
            : status === 404
              ? "not_found"
              : status >= 500
                ? "server_error"
                : "bad_request";
    return { outcome, status, message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { outcome: "network_error", message: redact(message) };
}

/** Outcomes that are worth another try on the same entry (after a short backoff). */
export const RETRYABLE: ReadonlySet<AttemptOutcome> = new Set([
  "rate_limited",
  "server_error",
  "network_error",
  "timeout",
]);
