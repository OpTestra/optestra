// The Action's one network exception (CI-1, guard-tested): the GitHub REST API
// at GITHUB_API_URL, with the workflow's GITHUB_TOKEN. Every request is pinned
// to that one host, never follows a redirect, and nothing else is ever sent.

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON body, or null. */
  body: unknown;
}

export interface GitHub {
  request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<GitHubResponse>;
}

export class GitHubError extends Error {
  override name = "GitHubError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function createGitHub(options: { apiUrl: string; token: string; fetch?: Fetch }): GitHub {
  const origin = new URL(options.apiUrl);
  const host = origin.host;
  const base = origin.href.replace(/\/$/, "");
  const send: Fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return {
    async request(method, path, body) {
      if (!path.startsWith("/")) throw new GitHubError(`bad API path "${path}"`, 0);
      const url = new URL(base + path);
      if (url.host !== host || url.protocol !== origin.protocol)
        throw new GitHubError(`refusing a request to ${url.host}: only ${host} is allowed`, 0);
      const response = await send(url.href, {
        method,
        redirect: "error",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${options.token}`,
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: response.status, ok: response.ok, body: parsed };
    },
  };
}
