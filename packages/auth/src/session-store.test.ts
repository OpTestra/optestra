import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brand } from "@testament/brand";
import { createLogger, Redactor } from "@testament/config/node";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthProfile } from "./section.js";
import {
  ensureProfile,
  type LoginRequest,
  SessionStore,
  type StorageState,
} from "./session-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PLANTED = "planted-cookie-7781-secret";

function state(value = PLANTED): StorageState {
  return {
    cookies: [
      {
        name: "sid",
        value,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
      // Short values are not registered (a "1" would scrub every 1 in every log).
      {
        name: "consent",
        value: "1",
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [
      { origin: "http://127.0.0.1:4100", localStorage: [{ name: "jwt", value: `jwt-${value}` }] },
    ],
  };
}

const ADMIN: AuthProfile = {
  flow: "flows/login-admin.test.md",
  params: { email: "{{data.admin_email}}" },
  check: { url: "/dashboard" },
  reuse: "per-worker",
  ttlMinutes: 60,
};
const SHARED: AuthProfile = { ...ADMIN, reuse: "shared" };

function setup() {
  const projectDir = mkdtempSync(join(tmpdir(), "auth-store-"));
  dirs.push(projectDir);
  let now = Date.parse("2026-09-26T10:00:00Z");
  const lines: string[] = [];
  const redactor = new Redactor();
  const store = new SessionStore({
    projectDir,
    now: () => now,
    redactor,
    logger: createLogger({ redactor, level: "debug", sink: (line) => lines.push(line) }),
  });
  const logins: LoginRequest[] = [];
  const runFlow = async (request: LoginRequest) => {
    logins.push(request);
    return { ok: true as const, storageState: state(`${PLANTED}-${logins.length}`) };
  };
  return {
    projectDir,
    store,
    lines,
    redactor,
    logins,
    runFlow,
    advance: (minutes: number) => {
      now += minutes * 60_000;
    },
  };
}

describe("SessionStore", () => {
  it("saves under <project>/<dataDir>/auth with owner-only permissions and a .gitignore", () => {
    const { store, projectDir } = setup();
    const key = store.keyFor("admin", ADMIN, { environment: "staging", worker: 2 });
    expect(key).toEqual({ environment: "staging", profile: "admin", worker: "w2" });
    store.save(key, state(), { ttlMinutes: 60, fingerprint: "f" });
    const file = store.fileFor(key);
    expect(file).toBe(join(projectDir, brand.dataDirName, "auth", "staging", "admin", "w2.json"));
    expect(readFileSync(join(store.dir, ".gitignore"), "utf8")).toContain("*");
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(store.dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(store.dir, "staging", "admin")).mode & 0o777).toBe(0o700);
    }
  });

  it("gives per-worker profiles one session per worker, shared profiles one for all", () => {
    const { store } = setup();
    const w0 = store.keyFor("admin", ADMIN, { environment: "staging", worker: 0 });
    const w1 = store.keyFor("admin", ADMIN, { environment: "staging", worker: 1 });
    expect(store.fileFor(w0)).not.toBe(store.fileFor(w1));
    const s0 = store.keyFor("viewer", SHARED, { environment: "staging", worker: 0 });
    const s1 = store.keyFor("viewer", SHARED, { environment: "staging", worker: 1 });
    expect(store.fileFor(s0)).toBe(store.fileFor(s1));
    expect(s0.worker).toBe("shared");
    // No environment selected: "default". Odd names can't escape the folder.
    const odd = store.keyFor("../../etc", SHARED, { environment: undefined, worker: 0 });
    expect(store.fileFor(odd).startsWith(join(store.dir, "default"))).toBe(true);
    expect(store.fileFor(odd)).not.toContain("..");
  });

  it("expires sessions after ttlMinutes and invalidates them when the profile changes", () => {
    const { store, advance } = setup();
    const key = store.keyFor("admin", ADMIN, { environment: "staging", worker: 0 });
    expect(store.load(key).status).toBe("none");
    store.save(key, state(), { ttlMinutes: 30, fingerprint: "v1" });
    expect(store.load(key, "v1").status).toBe("valid");
    expect(store.load(key, "v2").status).toBe("changed");
    advance(29);
    expect(store.load(key, "v1").status).toBe("valid");
    advance(1);
    expect(store.load(key, "v1").status).toBe("expired");
    expect(store.list()).toEqual([
      expect.objectContaining({
        environment: "staging",
        profile: "admin",
        worker: "w0",
        status: "expired",
      }),
    ]);
  });

  it("clears all sessions, or one profile's", () => {
    const { store } = setup();
    for (const [profile, worker] of [
      ["admin", 0],
      ["admin", 1],
      ["viewer", 0],
    ] as const) {
      store.save(store.keyFor(profile, ADMIN, { environment: "staging", worker }), state(), {
        ttlMinutes: 60,
        fingerprint: "f",
      });
    }
    expect(store.list()).toHaveLength(3);
    expect(store.clear({ profile: "admin" })).toBe(2);
    expect(store.list().map((e) => e.profile)).toEqual(["viewer"]);
    expect(store.clear()).toBe(1);
    expect(store.list()).toEqual([]);
  });
});

describe("ensureProfile", () => {
  it("logs in once, reuses the valid saved session, and logs in again once it expires", async () => {
    const { store, logins, runFlow, advance } = setup();
    const auth = { profiles: { admin: ADMIN } };
    const validated: string[] = [];
    const validate = async ({
      storageState,
      check,
    }: {
      storageState: StorageState;
      check: { url: string };
    }) => {
      validated.push(`${check.url} ${storageState.cookies[0]?.name}`);
      return true;
    };
    const options = { store, auth, environment: "staging", worker: 0, runFlow, validate };

    const first = await ensureProfile("admin", options);
    expect(first).toMatchObject({ status: "ready", source: "login" });
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({ profileName: "admin", environment: "staging", worker: 0 });

    advance(30);
    const second = await ensureProfile("admin", options);
    expect(second).toMatchObject({ status: "ready", source: "saved" });
    expect(second.status === "ready" && second.storageState.cookies[0]?.value).toBe(`${PLANTED}-1`);
    expect(validated).toEqual(["/dashboard sid"]);
    expect(logins).toHaveLength(1);

    advance(31); // past the 60-minute ttl
    const third = await ensureProfile("admin", options);
    expect(third).toMatchObject({ status: "ready", source: "login" });
    expect(logins).toHaveLength(2);
  });

  it("logs in again when the saved session no longer works (check fails)", async () => {
    const { store, logins, runFlow } = setup();
    const options = {
      store,
      auth: { profiles: { admin: ADMIN } },
      environment: "staging",
      worker: 0,
      runFlow,
    };
    await ensureProfile("admin", options);
    const again = await ensureProfile("admin", { ...options, validate: async () => false });
    expect(again).toMatchObject({ status: "ready", source: "login" });
    expect(logins).toHaveLength(2);
    // A validate that throws counts as "doesn't work", not as an error.
    const thrown = await ensureProfile("admin", {
      ...options,
      validate: async () => {
        throw new Error("browser crashed");
      },
    });
    expect(thrown).toMatchObject({ status: "ready", source: "login" });
  });

  it("per-worker sessions log in per worker; shared sessions log in once for all", async () => {
    const { store, logins, runFlow } = setup();
    const auth = { profiles: { admin: ADMIN, viewer: SHARED } };
    const base = { store, auth, environment: "staging", runFlow };
    await Promise.all([0, 1, 2].map((worker) => ensureProfile("admin", { ...base, worker })));
    expect(logins.map((l) => l.worker).sort()).toEqual([0, 1, 2]);
    logins.length = 0;
    const shared = await Promise.all(
      [0, 1, 2].map((worker) => ensureProfile("viewer", { ...base, worker })),
    );
    expect(logins).toHaveLength(1);
    expect(shared.every((r) => r.status === "ready")).toBe(true);
  });

  it("returns typed failures and never throws", async () => {
    const { store } = setup();
    const auth = { profiles: { admin: ADMIN } };
    const base = { store, auth, environment: "staging", worker: 0 };
    expect(
      await ensureProfile("nobody", {
        ...base,
        runFlow: async () => ({ ok: false, reason: "x", message: "x" }),
      }),
    ).toMatchObject({
      status: "failed",
      reason: "unknown_profile",
    });
    expect(
      await ensureProfile("admin", {
        ...base,
        runFlow: async () => ({
          ok: false,
          reason: "check_failed",
          message: 'Expect: the heading is "Dashboard" failed',
        }),
      }),
    ).toMatchObject({ status: "failed", reason: "login_failed" });
    const thrown = await ensureProfile("admin", {
      ...base,
      runFlow: async () => {
        throw new Error("boom");
      },
    });
    expect(thrown).toMatchObject({ status: "failed", reason: "login_failed" });
    expect(thrown.status === "failed" && thrown.message).toContain("boom");
    expect(store.list()).toEqual([]);
  });

  it("never lets a planted cookie or storage value reach logs, listings or results", async () => {
    const { store, lines, redactor, runFlow, projectDir } = setup();
    const options = {
      store,
      auth: { profiles: { admin: ADMIN } },
      environment: "staging",
      worker: 0,
      runFlow,
    };
    const first = await ensureProfile("admin", options);
    const second = await ensureProfile("admin", options);
    // A report built from the results is scrubbed by the same redactor.
    const report = redactor.redact(JSON.stringify({ first, second, list: store.list() }));
    expect(lines.length).toBeGreaterThan(0);
    for (const text of [lines.join("\n"), report]) {
      expect(text).not.toContain(PLANTED);
    }
    expect(report).toContain("[session:admin]");
    // The saved file itself keeps the real value (it is what the browser needs).
    expect(readFileSync(store.fileFor(store.keyFor("admin", ADMIN, options)), "utf8")).toContain(
      PLANTED,
    );
    // A value loaded from disk in a later process is registered too.
    const fresh = new Redactor();
    const later = new SessionStore({
      projectDir,
      redactor: fresh,
      now: () => Date.parse("2026-09-26T10:05:00Z"),
    });
    const loaded = later.load(later.keyFor("admin", ADMIN, options));
    expect(loaded.status).toBe("valid");
    expect(fresh.redact(`cookie ${PLANTED}-1`)).toBe("cookie [session:admin]");
  });
});
