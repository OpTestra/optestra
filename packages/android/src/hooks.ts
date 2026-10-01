import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Allowlist, HookRequest, HookResult } from "@optestra/browser";

// Setup/teardown requests (AUT-10) for Android tests. They seed the app's backend
// from this machine, not from the device, so they go to the environment's
// `baseUrl` (e.g. http://127.0.0.1:4180 for the fixture's shop) or to an allowed
// host. Nothing else is reachable; redirects are never followed (Node's client
// doesn't). Not an agent action: the model has no tool for it.

const HOST_ALIAS = "10.0.2.2";
const TIMEOUT_MS = 30_000;

/** Where a hook may go: an allowed host, or the environment's own baseUrl host. */
export function hookAllowed(url: URL, allowlist: Allowlist, baseUrl: string | undefined): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (allowlist.allowsUrl(url)) return true;
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).host === url.host;
  } catch {
    return false;
  }
}

export async function sendHookRequest(
  request: HookRequest,
  context: { allowlist: Allowlist; baseUrl: string | undefined; redact: (text: string) => string },
): Promise<HookResult> {
  let url: URL;
  try {
    url = context.baseUrl ? new URL(request.target, context.baseUrl) : new URL(request.target);
  } catch {
    return {
      status: "refused",
      reason: "invalid_action",
      message: `"${request.target}" is not a valid URL.`,
    };
  }
  if (!hookAllowed(url, context.allowlist, context.baseUrl)) {
    return {
      status: "refused",
      reason: "disallowed_domain",
      message: context.redact(`${url.host || url.protocol} is not in the allowed domains.`),
    };
  }
  // The device's name for this machine means this machine here.
  const host = url.hostname === HOST_ALIAS ? "127.0.0.1" : url.hostname;
  const body =
    request.body === undefined
      ? undefined
      : typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body);
  const headers: Record<string, string> = { ...request.headers };
  if (body !== undefined && typeof request.body !== "string" && !headers["content-type"])
    headers["content-type"] = "application/json";
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<HookResult>((resolve) => {
    const req = send(
      {
        host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        timeout: request.timeoutMs ?? TIMEOUT_MS,
        ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (text.length < 300) text += chunk;
        });
        response.on("end", () => {
          const httpStatus = response.statusCode ?? 0;
          if (httpStatus >= 200 && httpStatus < 300) resolve({ status: "ok", httpStatus });
          else
            resolve({
              status: "failed",
              httpStatus,
              message: context.redact(
                `${request.method} ${url.pathname} answered ${httpStatus}${text ? `: ${text.slice(0, 300)}` : ""}`,
              ),
            });
        });
      },
    );
    req.once("timeout", () => req.destroy(new Error("The request timed out.")));
    req.once("error", (error) =>
      resolve({ status: "error", message: context.redact(error.message) }),
    );
    if (body !== undefined) req.write(body);
    req.end();
  });
}
