import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { brand } from "@optestra/brand";
import { ENV_PREFIX } from "@optestra/config";
import type { Event } from "@optestra/contract";
import type { CommandIo } from "./config.js";

// The hosted runner (CLI-2 `--cloud`, CLOUD-2): `cloud login` signs the command
// line in the way the desktop app does (the browser, then a one-time code back
// to a listener on 127.0.0.1, traded for a 90-day token with a PKCE verifier);
// `run --cloud` uploads the project's changed files, starts the run in the
// cloud's queue, prints its events as they happen and exits with its exit code.
// CI uses <PREFIX>TOKEN and <PREFIX>CLOUD_URL instead of a sign-in.
//
// Only the project's own files go up (tests, recordings, the project file):
// never .env files, saved logins, run folders, .git or node_modules. Secrets
// stay here; a cloud run uses the ones set in the web app.

const SYNC = "/api/sync";
const SIGN_IN = "/api/auth/desktop";
const TOKEN = "/api/auth/desktop/token";
const MAX_FILE = 32 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);
const POLL_MS = 1_000;

export interface CloudIo extends CommandIo {
  fetch?: typeof fetch;
  /** Opens a URL in the browser (default: the system's opener). */
  openBrowser?: (url: string) => void;
  signal?: AbortSignal;
  /** Tests: shorter waits. */
  pollMs?: number;
}

interface Credentials {
  url: string;
  token: string;
  expiresAt: string;
  email: string;
}

export class CloudError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const prefix = ENV_PREFIX;

/** Where `cloud login` keeps its token: the user's config folder, readable by them only. */
export function credentialsFile(env: CommandIo["env"]): string {
  const base =
    env.XDG_CONFIG_HOME ??
    (process.platform === "win32" && env.APPDATA
      ? env.APPDATA
      : join(env.HOME ?? homedir(), ".config"));
  return join(base, brand.cliName, "cloud.json");
}

const cleanUrl = (url: string) => url.replace(/\/+$/, "");
const okUrl = (url: string) =>
  /^https:\/\/[^/]+$/.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url);

function readCredentials(env: CommandIo["env"]): Credentials | null {
  try {
    const value = JSON.parse(readFileSync(credentialsFile(env), "utf8")) as Credentials;
    return value.token && value.url ? value : null;
  } catch {
    return null;
  }
}

/** The cloud to talk to and the token: <PREFIX>TOKEN (CI) first, else the saved sign-in. */
export function cloudOf(io: CommandIo, cloudUrl?: string): { url: string; token: string } {
  const envToken = io.env[`${prefix}TOKEN`];
  const saved = readCredentials(io.env);
  const url = cleanUrl(cloudUrl ?? io.env[`${prefix}CLOUD_URL`] ?? saved?.url ?? "");
  const token = envToken ?? (saved && cleanUrl(saved.url) === url ? saved.token : undefined);
  if (!url || !okUrl(url))
    throw new CloudError(
      "No cloud address.",
      `Pass --cloud-url https://…, or set ${prefix}CLOUD_URL.`,
    );
  if (!token)
    throw new CloudError(
      "Not signed in to the cloud.",
      `Run \`${brand.cliName} cloud login --cloud-url ${url}\`, or set ${prefix}TOKEN in CI.`,
    );
  return { url, token };
}

async function sync<T>(
  io: CloudIo,
  cloud: { url: string; token: string },
  method: string,
  input: unknown,
): Promise<T> {
  const doFetch = io.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${cloud.url}${SYNC}/${method}`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${cloud.token}` },
      body: JSON.stringify(input),
    });
  } catch {
    throw new CloudError("Can't reach the cloud.", "Check the address and your connection.");
  }
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    value?: T;
    error?: { code: string; message: string; fix?: string };
  } | null;
  if (response.status === 401 || body?.error?.code === "signed_out")
    throw new CloudError(
      "The cloud sign-in has ended.",
      `Run \`${brand.cliName} cloud login\` again (or check ${prefix}TOKEN).`,
      "signed_out",
    );
  if (!body?.ok)
    throw new CloudError(
      body?.error?.message ?? `The cloud answered ${response.status}.`,
      body?.error?.fix,
      body?.error?.code,
    );
  return body.value as T;
}

/** `cloud login`: the desktop's sign-in, with the code coming back to 127.0.0.1. */
export async function runCloudLogin(options: { cloudUrl?: string }, io: CloudIo): Promise<number> {
  const url = cleanUrl(
    options.cloudUrl ?? io.env[`${prefix}CLOUD_URL`] ?? readCredentials(io.env)?.url ?? "",
  );
  if (!url || !okUrl(url)) {
    io.stdout(`Which cloud? Pass --cloud-url https://… (or set ${prefix}CLOUD_URL).\n`);
    return 2;
  }
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const code = await new Promise<string | null>((done) => {
    const server = createServer((request, response) => {
      const at = new URL(request.url ?? "/", "http://127.0.0.1");
      if (at.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const ok = at.searchParams.get("state") === state && !!at.searchParams.get("code");
      response.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        ok
          ? `Signed in. You can close this tab and go back to the terminal.`
          : "That sign-in didn't match. Start it again from the terminal.",
      );
      server.close();
      done(ok ? at.searchParams.get("code") : null);
    });
    const timer = setTimeout(() => {
      server.close();
      done(null);
    }, 5 * 60_000);
    timer.unref();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const signIn = `${url}${SIGN_IN}?${new URLSearchParams({ challenge, state, port: String(port) })}`;
      io.stdout(
        `Opening the sign-in page in your browser. If it doesn't open, visit:\n  ${signIn}\n`,
      );
      if (io.openBrowser) io.openBrowser(signIn);
      else void import("@optestra/report/node").then(({ openFile }) => openFile(signIn));
    });
  });
  if (!code) {
    io.stdout("The sign-in didn't finish (it timed out or didn't match). Try again.\n");
    return 1;
  }
  const response = await (io.fetch ?? fetch)(`${url}${TOKEN}`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    value?: { token: string; expiresAt: string; user: { email: string } };
  } | null;
  if (!body?.ok || !body.value) {
    io.stdout("The cloud refused the sign-in code. Try again.\n");
    return 1;
  }
  const file = credentialsFile(io.env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const saved: Credentials = {
    url,
    token: body.value.token,
    expiresAt: body.value.expiresAt,
    email: body.value.user.email,
  };
  writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  io.stdout(`Signed in to ${url} as ${saved.email} (until ${saved.expiresAt.slice(0, 10)}).\n`);
  return 0;
}

/** `cloud logout`: ends the token on the cloud and forgets it here. */
export async function runCloudLogout(io: CloudIo): Promise<number> {
  const saved = readCredentials(io.env);
  if (!saved) {
    io.stdout("Not signed in.\n");
    return 0;
  }
  await sync(io, saved, "sync.signOut", {}).catch(() => undefined);
  rmSync(credentialsFile(io.env), { force: true });
  io.stdout("Signed out.\n");
  return 0;
}

/** The project's own files, project-relative: what a cloud run needs, nothing else. */
export function projectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      const info = lstatSync(full);
      if (info.isSymbolicLink() || SKIP.has(name)) continue;
      if (rel === brand.dataDirName || rel.startsWith(`${brand.dataDirName}/`)) continue;
      const parts = rel.split("/");
      // Saved logins and authoring scratch inside the tests folder, and every .env but the example.
      if (
        parts.some(
          (p, i) =>
            p === brand.dataDirName && (parts[i + 1] === "auth" || parts[i + 1] === "authoring"),
        )
      )
        continue;
      if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") continue;
      if (info.isDirectory()) walk(full);
      else if (info.isFile() && info.size <= MAX_FILE) out.push(rel);
    }
  };
  walk(root);
  return out;
}

const versionOf = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 32);

interface Link {
  url: string;
  workspaceId: string;
  projectId: string;
}

/** Uploads the changed files into the project's cloud copy (created on first use). */
async function push(
  io: CloudIo,
  cloud: { url: string; token: string },
  dir: string,
  name: string,
): Promise<Link & { uploaded: number }> {
  const linkFile = join(dir, brand.dataDirName, "cloud.json");
  let link: Link | null = null;
  try {
    link = JSON.parse(readFileSync(linkFile, "utf8")) as Link;
    if (link.url !== cloud.url) link = null;
  } catch {
    link = null;
  }
  const who = await sync<{ workspaces: { id: string; personal: boolean }[] }>(
    io,
    cloud,
    "sync.whoami",
    {},
  );
  const wanted = io.env[`${prefix}WORKSPACE`];
  const workspace =
    who.workspaces.find((w) => w.id === (wanted ?? link?.workspaceId)) ??
    (wanted ? undefined : (who.workspaces.find((w) => w.personal) ?? who.workspaces[0]));
  if (!workspace)
    throw new CloudError("That workspace doesn't exist, or you're not a member of it.");
  let remote = new Map<string, string | undefined>();
  let projectId = link?.workspaceId === workspace.id ? link.projectId : undefined;
  if (projectId) {
    try {
      const listed = await sync<{ files: { path: string; version?: string }[] }>(
        io,
        cloud,
        "sync.files",
        {
          workspaceId: workspace.id,
          projectId,
        },
      );
      remote = new Map(listed.files.map((f) => [f.path, f.version]));
    } catch (error) {
      if (!(error instanceof CloudError && error.code === "not_found")) throw error;
      projectId = undefined;
    }
  }
  if (!projectId) {
    projectId = (
      await sync<{ projectId: string }>(io, cloud, "sync.create", {
        workspaceId: workspace.id,
        name,
      })
    ).projectId;
    mkdirSync(dirname(linkFile), { recursive: true });
    writeFileSync(
      linkFile,
      `${JSON.stringify({ url: cloud.url, workspaceId: workspace.id, projectId }, null, 2)}\n`,
    );
  }
  let uploaded = 0;
  for (const path of projectFiles(dir)) {
    const data = readFileSync(join(dir, ...path.split("/")));
    if (remote.get(path) === versionOf(new Uint8Array(data))) continue;
    await sync(io, cloud, "sync.write", {
      workspaceId: workspace.id,
      projectId,
      path,
      data: data.toString("base64"),
    });
    uploaded += 1;
  }
  return { url: cloud.url, workspaceId: workspace.id, projectId, uploaded };
}

export interface CloudRunOptions {
  cloudUrl?: string;
  env?: string;
  replayOnly?: boolean;
  rerecord?: boolean;
  browser?: string[];
  device?: string[];
  locale?: string;
  timezone?: string;
  evidence?: string;
  viewport?: { width: number; height: number };
}

interface Handle {
  runId: string;
  state: "queued" | "running" | "finished" | "aborted" | "failed";
  message: string | null;
}

/**
 * `run --cloud`: the selected tests (already resolved by `run`'s own rules) run
 * in the cloud; their events print as they arrive; the exit code is the run's
 * (0 passed, 1 failed, 2 blocked or the cloud couldn't run it).
 */
export async function runInCloud(
  dir: string,
  projectName: string,
  tests: string[],
  healedCountsAsPass: boolean,
  options: CloudRunOptions,
  io: CloudIo,
  print: { onEvent: (event: Event) => void; summary: (events: Event[]) => number },
): Promise<number> {
  try {
    const cloud = cloudOf(io, options.cloudUrl);
    io.stdout(`Uploading ${projectName} to ${cloud.url}…\n`);
    const link = await push(io, cloud, dir, projectName);
    io.stdout(`  ${link.uploaded} file${link.uploaded === 1 ? "" : "s"} changed.\n`);
    const { detectBranch } = await import("@optestra/recording/node");
    const branch = detectBranch(io.env, dir);
    const pr = /^refs\/pull\/(\d+)\//.exec(io.env.GITHUB_REF ?? "")?.[1] ?? null;
    const several = <T>(list: T[] | undefined) => (list && list.length > 1 ? list : undefined);
    const run = {
      projectId: link.projectId,
      selection: { kind: "tests", paths: tests },
      ...(options.env ? { environment: options.env } : {}),
      ...(options.replayOnly
        ? { mode: "replay-only" }
        : options.rerecord
          ? { mode: "rerecord" }
          : {}),
      ...(options.browser?.[0] ? { browser: options.browser[0] } : {}),
      ...(several(options.browser) ? { browsers: options.browser } : {}),
      ...(options.device?.[0] ? { device: options.device[0] } : {}),
      ...(several(options.device) ? { devices: options.device } : {}),
      ...(options.locale ? { locale: options.locale } : {}),
      ...(options.timezone ? { timezone: options.timezone } : {}),
      ...(options.evidence ? { evidence: options.evidence } : {}),
      ...(options.viewport ? { viewport: options.viewport } : {}),
    };
    let handle = await sync<Handle>(io, cloud, "sync.runStart", {
      workspaceId: link.workspaceId,
      run,
      trigger: "cli",
      git: branch ? { branch: branch.name, commit: io.env.GITHUB_SHA ?? null, pr } : null,
    });
    io.stdout(
      `Run ${handle.runId} ${handle.state === "queued" ? "is queued" : "started"} in the cloud.\n`,
    );
    const stop = async () => {
      io.stdout("\nStopping the cloud run…\n");
      await sync(io, cloud, "sync.runCancel", {
        workspaceId: link.workspaceId,
        runId: handle.runId,
      }).catch(() => undefined);
    };
    let stopping = false;
    io.signal?.addEventListener("abort", () => {
      stopping = true;
      void stop();
    });
    const events: Event[] = [];
    let after = -1;
    for (;;) {
      const answer = await sync<{ handle: Handle; events: Event[]; live: boolean }>(
        io,
        cloud,
        "sync.runEvents",
        { workspaceId: link.workspaceId, runId: handle.runId, after },
      );
      handle = answer.handle;
      for (const event of answer.events) {
        if (event.seq <= after) continue;
        events.push(event);
        after = event.seq;
        print.onEvent(event);
      }
      if (!answer.live && answer.events.length === 0) break;
      if (!answer.live) continue;
      await new Promise((r) => setTimeout(r, io.pollMs ?? POLL_MS));
    }
    void healedCountsAsPass;
    if (
      handle.state === "failed" ||
      (handle.state === "aborted" && !stopping && events.length === 0)
    ) {
      io.stdout(
        `\nThe cloud couldn't finish the run: ${handle.message ?? "no reason given"}\n  exit code 2\n`,
      );
      return 2;
    }
    const code = events.length > 0 ? print.summary(events) : 2;
    io.stdout(`  Results: ${cloud.url}/ (run ${handle.runId})\n`);
    return stopping ? 130 : code;
  } catch (error) {
    if (error instanceof CloudError) {
      io.stdout(`${error.message}${error.fix ? `\n  ${error.fix}` : ""}\n`);
      return 2;
    }
    throw error;
  }
}

/** Resolves the run's tests to project-relative files (the cloud runs exactly these). */
export function relativeTests(dir: string, files: readonly string[]): string[] {
  return files.map((file) => relative(resolve(dir), resolve(dir, file)).split(sep).join("/"));
}

export const hasCloudCredentials = (env: CommandIo["env"]) =>
  !!env[`${prefix}TOKEN`] || existsSync(credentialsFile(env));
