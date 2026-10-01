import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthProfile, SessionStore, type StorageState } from "@optestra/auth";
import { createLogger, Redactor } from "@optestra/config/node";
import { afterEach, describe, expect, it } from "vitest";
import { type ProfileLoginOptions, profileLogin } from "./profiles.js";
import type { ReplayResult } from "./types.js";

// Auth profiles in runs (SEC-3): reuse a valid saved session, log in again when
// it expired, changed or no longer passes its check, one session per worker (or
// shared), and honest outcomes when the login flow doesn't complete.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const COOKIE = "sess-cookie-value-9f8e7d";
const state = (value = COOKIE): StorageState => ({
  cookies: [
    {
      name: "acme_session",
      value,
      domain: "127.0.0.1",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ],
  origins: [],
});

const profile = (extra: Partial<AuthProfile> = {}): AuthProfile => ({
  flow: "flows/login.test.md",
  params: {},
  check: { url: "/dashboard" },
  reuse: "per-worker",
  ttlMinutes: 60,
  ...extra,
});

/** A test session whose server knows `valid` cookies: /dashboard stays, anything else goes to /login. */
function fakeSession(valid: Set<string>) {
  let cookie: string | undefined;
  let url = "http://127.0.0.1:4100/";
  const used: string[] = [];
  return {
    used,
    session: {
      get url() {
        return url;
      },
      async useStorageState(s: StorageState) {
        cookie = s.cookies[0]?.value;
        used.push(cookie ?? "");
      },
      async act(action: { type: string; url?: unknown }) {
        const path = String(action.url);
        url = `http://127.0.0.1:4100${cookie && valid.has(cookie) ? path : "/login"}`;
        return { status: "ok" } as never;
      },
      async check() {
        return { status: "passed", passed: true } as never;
      },
    } as unknown as ProfileLoginOptions["session"],
  };
}

const passed = { status: "passed", modelCalls: [], heals: [] } as unknown as ReplayResult;

function setup(now = { t: Date.parse("2026-09-27T10:00:00Z") }) {
  const dir = mkdtempSync(join(tmpdir(), "profiles-"));
  dirs.push(dir);
  const redactor = new Redactor();
  const lines: string[] = [];
  const store = new SessionStore({
    projectDir: dir,
    now: () => now.t,
    redactor,
    logger: createLogger({ sink: (line) => lines.push(line), redactor }),
  });
  return { store, redactor, lines, now };
}

function login(
  store: SessionStore,
  session: ProfileLoginOptions["session"],
  runFlow: ProfileLoginOptions["runFlow"],
  extra: Partial<ProfileLoginOptions> = {},
) {
  const p = extra.profile ?? profile();
  return profileLogin({
    name: "ada",
    profile: p,
    auth: { profiles: { ada: p } },
    store,
    environment: "local",
    worker: 0,
    session,
    stepIndex: 9,
    runFlow,
    ...extra,
  });
}

describe("auth profiles in runs", () => {
  it("logs in once, then reuses the saved session (validated by its check) with no login step", async () => {
    const { store, redactor, lines } = setup();
    const valid = new Set([COOKIE]);
    let flows = 0;
    const runFlow = async () => {
      flows++;
      return { ok: true as const, result: passed, storageState: state() };
    };
    const first = await login(store, fakeSession(valid).session, runFlow);
    expect(first).toMatchObject({
      status: "ready",
      step: {
        index: 9,
        kind: "flow",
        status: "passed",
        text: "auth: ada (logs in with flows/login.test.md)",
      },
    });
    const test = fakeSession(valid);
    const second = await login(store, test.session, runFlow);
    expect(second.status).toBe("ready");
    expect(second.step).toBeUndefined();
    expect(second.logs?.[0]).toMatch(/reused the saved session/);
    expect(flows).toBe(1);
    expect(test.used).toContain(COOKIE);
    // The cookie is registered with the redactor: no log or report can show it.
    expect(redactor.redact(`cookie ${COOKIE}`)).toBe("cookie [session:ada]");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).not.toContain(COOKIE);
  });

  it("logs in again when the saved session expired or no longer passes its check", async () => {
    const { store, now } = setup();
    let flows = 0;
    const runFlow = async () => {
      flows++;
      return { ok: true as const, result: passed, storageState: state(`cookie-${flows}-abcdef`) };
    };
    const valid = new Set(["cookie-1-abcdef", "cookie-2-abcdef", "cookie-3-abcdef"]);
    await login(store, fakeSession(valid).session, runFlow);
    now.t += 61 * 60_000; // past ttlMinutes
    expect((await login(store, fakeSession(valid).session, runFlow)).step?.status).toBe("passed");
    expect(flows).toBe(2);
    // The server forgot the session (e.g. a reset): the check lands on /login.
    valid.delete("cookie-2-abcdef");
    const again = await login(store, fakeSession(valid).session, runFlow);
    expect(again.step?.status).toBe("passed");
    expect(flows).toBe(3);
  });

  it("gives each worker its own session (per-worker), and one for all when shared", async () => {
    const { store } = setup();
    let flows = 0;
    const runFlow = async () => {
      flows++;
      return { ok: true as const, result: passed, storageState: state(`worker-cookie-${flows}`) };
    };
    const valid = new Set(["worker-cookie-1", "worker-cookie-2"]);
    await login(store, fakeSession(valid).session, runFlow, { worker: 0 });
    await login(store, fakeSession(valid).session, runFlow, { worker: 1 });
    expect(flows).toBe(2);
    expect(store.list().map((e) => e.worker)).toEqual(["w0", "w1"]);

    const shared = setup();
    let logins = 0;
    const sharedFlow = async () => {
      logins++;
      return { ok: true as const, result: passed, storageState: state("shared-cookie-1") };
    };
    const p = profile({ reuse: "shared" });
    const both = await Promise.all(
      [0, 1].map((worker) =>
        login(shared.store, fakeSession(new Set(["shared-cookie-1"])).session, sharedFlow, {
          worker,
          profile: p,
        }),
      ),
    );
    expect(both.map((b) => b.status)).toEqual(["ready", "ready"]);
    expect(logins).toBe(1);
    expect(shared.store.list().map((e) => e.worker)).toEqual(["shared"]);
  });

  it("fails the test when the login flow fails (the app's login is broken), blocks for our reasons", async () => {
    const { store } = setup();
    const session = fakeSession(new Set()).session;
    const broken = await login(store, session, async () => ({
      ok: false,
      result: passed,
      reason: "failed",
      message:
        'Step 5 "Expect: the page heading is "Dashboard"": expected "Dashboard", found "Something went wrong".',
    }));
    expect(broken).toMatchObject({
      status: "failed",
      step: { kind: "flow", status: "failed" },
      message: expect.stringMatching(
        /^auth: ada: logging in with flows\/login\.test\.md failed: Step 5/,
      ),
    });
    const noSecret = await login(store, session, async () => ({
      ok: false,
      reason: "missing_secret",
      message: "Secret SHOP_PASSWORD is not set.",
    }));
    expect(noSecret).toMatchObject({ status: "blocked", reason: "missing_secret" });
    const other = await login(store, session, async () => ({
      ok: false,
      reason: "setup_failed",
      message: "Setup POST /__test/seed failed",
    }));
    expect(other).toMatchObject({ status: "blocked", reason: "login_failed" });
    expect(store.list()).toEqual([]);
  });
});
