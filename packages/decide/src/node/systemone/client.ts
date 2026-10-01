import { defaultRedactor, SecretValue } from "@optestra/config/node";
import { revealSecret } from "@optestra/config/reveal";
import type {
  BackendCallOptions,
  BackendRequest,
  BackendResponse,
  DecisionBackend,
} from "../../backend.js";
import { createTransport, type FetchLike, type Transport } from "./transport.js";
import { type Flavor, failureFromHttp, fromWireResponse, toWireRequest } from "./wire.js";

export interface SystemOneBackendOptions {
  /** Recorded as the decision source and part of the cache key: jev, kev or laya. */
  id: string;
  /** Scheme, host and optional port. Every request is pinned to this host. */
  baseUrl: string;
  model: string;
  /** Bearer key. A `SecretValue` is revealed only when a request to `baseUrl` is built. */
  apiKey?: SecretValue | string | undefined;
  /** systemone: `POST /v1/systemone` (Jev, Kev). ollaya: `POST /api/decide` (Laya). */
  flavor: Flavor;
  /** Ollaya only: how long the model stays loaded between decisions. */
  keepAlive?: string;
  /** For the run cost: USD per million input tokens. */
  priceUsdPerMillionInputTokens?: number;
  /** Typical request latency; tasks with a shorter time limit won't call this backend. */
  expectedLatencyMs?: number;
  /** Applied to the state and instructions before they leave. Default: the process-wide redactor. */
  scrub?: (text: string) => string;
  fetch?: FetchLike;
}

export interface BackendUsageTotals {
  /** Requests sent, including the warm-up. */
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** USD for the input tokens at the configured price. */
  costUsd: number;
  /** Requests whose state the backend truncated to fit its context. */
  truncatedStates: number;
}

export interface SystemOneBackend extends DecisionBackend {
  readonly flavor: Flavor;
  readonly baseUrl: string;
  readonly model: string;
  /** host[:port] every request is pinned to. */
  readonly host: string;
  /** Totals since the backend was created, for the run cost. */
  usage(): BackendUsageTotals;
}

const WARM_UP: BackendRequest = {
  state: "Warm-up request from the test runner.",
  questions: { ready: { kind: "noul", instructions: "This text is a warm-up request." } },
};

/**
 * One System One client for Jev (hosted), Kev (self-hosted) and Laya (through
 * Ollaya). Never throws: every problem is a `{ ok: false, failure }`.
 */
export function createSystemOneBackend(options: SystemOneBackendOptions): SystemOneBackend {
  const transport: Transport = createTransport(options.baseUrl, options.fetch);
  const scrub = options.scrub ?? ((text: string) => defaultRedactor.redact(text));
  const price = options.priceUsdPerMillionInputTokens ?? 0;
  const path = options.flavor === "ollaya" ? "/api/decide" : "/v1/systemone";
  const totals: BackendUsageTotals = {
    requests: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    truncatedStates: 0,
  };

  const authorization = (): Record<string, string> => {
    if (options.apiKey === undefined) return {};
    // The key is revealed only here, for a request pinned to this backend's own host.
    const key =
      options.apiKey instanceof SecretValue ? revealSecret(options.apiKey) : options.apiKey;
    return { authorization: `Bearer ${key}` };
  };

  async function answer(
    request: BackendRequest,
    { signal, timeoutMs }: BackendCallOptions,
  ): Promise<BackendResponse> {
    totals.requests++;
    const body = toWireRequest({
      model: options.model,
      state: request.state,
      questions: request.questions,
      flavor: options.flavor,
      ...(options.keepAlive ? { keepAlive: options.keepAlive } : {}),
      scrub,
    });
    const result = await transport.request({
      method: "POST",
      path,
      body,
      headers: authorization(),
      signal,
      timeoutMs,
    });
    let response: BackendResponse;
    if (result.kind === "error") {
      response = { ok: false, failure: { reason: result.reason, message: result.message } };
    } else if (result.status < 200 || result.status >= 300) {
      response = { ok: false, failure: failureFromHttp(result.status, result.json) };
    } else {
      response = fromWireResponse(request.questions, result.json);
    }
    if (response.ok) {
      if (response.usage) {
        totals.inputTokens += response.usage.inputTokens;
        totals.outputTokens += response.usage.outputTokens;
        totals.costUsd += (response.usage.inputTokens / 1_000_000) * price;
      }
      if (response.stateTruncated) totals.truncatedStates++;
    } else {
      totals.failures++;
    }
    return response;
  }

  const backend: SystemOneBackend = {
    id: options.id,
    flavor: options.flavor,
    baseUrl: options.baseUrl,
    model: options.model,
    host: transport.host,
    usage: () => ({ ...totals }),
    answer,
    ...(options.expectedLatencyMs !== undefined
      ? { expectedLatencyMs: options.expectedLatencyMs }
      : {}),
  };
  if (options.flavor === "ollaya") {
    // Loads the model (≈2 s on first use) so the first real 100 ms decision isn't cut off.
    backend.warmUp = ({ timeoutMs, signal }) =>
      answer(WARM_UP, { signal: signal ?? new AbortController().signal, timeoutMs });
  }
  return backend;
}
