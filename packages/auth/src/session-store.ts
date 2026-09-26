import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { brand } from "@testament/brand";
import { defaultRedactor, type Logger, logger, type Redactor } from "@testament/config/node";
import type { AuthProfile, AuthSettings } from "./section.js";

// Saved login sessions (SEC-3): Playwright storage state per project, environment,
// profile and worker, under <project>/<dataDir>/auth/. Owner-only permissions,
// git-ignored, never in artifacts, reports or logs.

/** Playwright storage state (cookies + local storage). Same shape as the browser harness's. */
export interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export interface SessionKey {
  /** The environment name, or `default` when the project has none selected. */
  environment: string;
  profile: string;
  /** `shared`, or `w<index>` for per-worker profiles. */
  worker: string;
}

interface SessionFile {
  version: 1;
  environment: string;
  profile: string;
  worker: string;
  /** Hash of the profile definition: changing flow, params or check invalidates the session. */
  fingerprint: string;
  savedAt: string;
  expiresAt: string;
  storageState: StorageState;
}

export type SavedSession =
  | { status: "valid"; storageState: StorageState; savedAt: string; expiresAt: string }
  | { status: "expired" | "changed"; savedAt: string; expiresAt: string }
  | { status: "none" };

export interface SessionEntry extends SessionKey {
  status: "valid" | "expired" | "unreadable";
  savedAt?: string;
  expiresAt?: string;
}

export interface SessionStoreOptions {
  projectDir: string;
  /** Clock (ms); tests pass their own. */
  now?: () => number;
  /** Cookie and storage values are registered here so no log or report can show them. */
  redactor?: Redactor;
  logger?: Logger;
}

/** Values shorter than this aren't registered with the redactor (a "1" would scrub every 1). */
const MIN_SENSITIVE_LENGTH = 6;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

function segment(value: string): string {
  return SEGMENT.test(value) && value !== "." && value !== ".."
    ? value
    : `_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

/** Hash of what makes a saved session valid for a profile. */
export function profileFingerprint(profile: AuthProfile): string {
  const { flow, params, check } = profile;
  const sorted = Object.fromEntries(
    Object.entries(params ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash("sha256")
    .update(JSON.stringify({ flow, params: sorted, check: check ?? null }))
    .digest("hex")
    .slice(0, 16);
}

/** Registers every cookie and local storage value with the redactor. */
export function registerStorageState(
  state: StorageState,
  label: string,
  redactor: Redactor = defaultRedactor,
): void {
  const values = [
    ...(state.cookies ?? []).map((cookie) => cookie.value),
    ...(state.origins ?? []).flatMap((origin) => origin.localStorage.map((item) => item.value)),
  ];
  for (const value of values) {
    if (typeof value === "string" && value.length >= MIN_SENSITIVE_LENGTH) {
      redactor.register(value, label);
    }
  }
}

function isStorageState(value: unknown): value is StorageState {
  const state = value as StorageState;
  return (
    typeof state === "object" &&
    state !== null &&
    Array.isArray(state.cookies) &&
    Array.isArray(state.origins)
  );
}

export class SessionStore {
  /** `<project>/<dataDir>/auth`. */
  readonly dir: string;
  readonly #now: () => number;
  readonly #redactor: Redactor;
  readonly #log: Logger;

  constructor(options: SessionStoreOptions) {
    this.dir = join(options.projectDir, brand.dataDirName, "auth");
    this.#now = options.now ?? Date.now;
    this.#redactor = options.redactor ?? defaultRedactor;
    this.#log = options.logger ?? logger;
  }

  /** The key for a profile: per-worker profiles get one session per worker. */
  keyFor(
    profileName: string,
    profile: Pick<AuthProfile, "reuse">,
    where: { environment: string | undefined; worker: number | string },
  ): SessionKey {
    return {
      environment: where.environment ?? "default",
      profile: profileName,
      worker: profile.reuse === "shared" ? "shared" : `w${where.worker}`,
    };
  }

  /** Where a key's session is saved. */
  fileFor(key: SessionKey): string {
    return join(
      this.dir,
      segment(key.environment),
      segment(key.profile),
      `${segment(key.worker)}.json`,
    );
  }

  /** A saved session: valid, expired, made for a different profile definition, or none. */
  load(key: SessionKey, fingerprint?: string): SavedSession {
    const file = this.#read(this.fileFor(key));
    if (!file) return { status: "none" };
    const times = { savedAt: file.savedAt, expiresAt: file.expiresAt };
    if (fingerprint !== undefined && file.fingerprint !== fingerprint) {
      return { status: "changed", ...times };
    }
    if (Date.parse(file.expiresAt) <= this.#now()) return { status: "expired", ...times };
    registerStorageState(file.storageState, `[session:${key.profile}]`, this.#redactor);
    return { status: "valid", storageState: file.storageState, ...times };
  }

  /** Saves a session for `ttlMinutes`, owner-only, atomically. */
  save(
    key: SessionKey,
    storageState: StorageState,
    options: { ttlMinutes: number; fingerprint: string },
  ): { savedAt: string; expiresAt: string } {
    registerStorageState(storageState, `[session:${key.profile}]`, this.#redactor);
    const now = this.#now();
    const record: SessionFile = {
      version: 1,
      ...key,
      fingerprint: options.fingerprint,
      savedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + options.ttlMinutes * 60_000).toISOString(),
      storageState,
    };
    const path = this.fileFor(key);
    this.#ensureDirs(path);
    const temp = `${path}.${process.pid}.${now}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    return { savedAt: record.savedAt, expiresAt: record.expiresAt };
  }

  /** Deletes saved sessions (all, or one profile's, optionally in one environment). Returns how many. */
  clear(filter: { profile?: string; environment?: string } = {}): number {
    let removed = 0;
    for (const entry of this.list()) {
      if (filter.profile !== undefined && entry.profile !== filter.profile) continue;
      if (filter.environment !== undefined && entry.environment !== filter.environment) continue;
      rmSync(this.fileFor(entry), { force: true });
      removed++;
    }
    return removed;
  }

  /** Every saved session, without its contents. */
  list(): SessionEntry[] {
    const entries: SessionEntry[] = [];
    const dirs = (path: string) =>
      existsSync(path)
        ? readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory())
        : [];
    for (const env of dirs(this.dir)) {
      for (const profile of dirs(join(this.dir, env.name))) {
        const folder = join(this.dir, env.name, profile.name);
        for (const name of readdirSync(folder)) {
          if (!name.endsWith(".json")) continue;
          const file = this.#read(join(folder, name));
          const key = file
            ? { environment: file.environment, profile: file.profile, worker: file.worker }
            : { environment: env.name, profile: profile.name, worker: name.slice(0, -5) };
          entries.push(
            file
              ? {
                  ...key,
                  status: Date.parse(file.expiresAt) <= this.#now() ? "expired" : "valid",
                  savedAt: file.savedAt,
                  expiresAt: file.expiresAt,
                }
              : { ...key, status: "unreadable" },
          );
        }
      }
    }
    return entries.sort((a, b) =>
      `${a.environment}/${a.profile}/${a.worker}`.localeCompare(
        `${b.environment}/${b.profile}/${b.worker}`,
      ),
    );
  }

  /**
   * Runs `fn` holding a lock for `key`, across processes (a lock file) so two
   * workers sharing a profile log in once. A lock older than `staleMs` is taken over.
   */
  async withLock<T>(key: SessionKey, fn: () => Promise<T>, staleMs = 5 * 60_000): Promise<T> {
    const path = `${this.fileFor(key)}.lock`;
    this.#ensureDirs(path);
    for (;;) {
      try {
        closeSync(openSync(path, "wx", 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let age = 0;
        try {
          age = Date.now() - statSync(path).mtimeMs;
        } catch {
          continue; // released between the two calls
        }
        if (age > staleMs) {
          rmSync(path, { force: true });
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(path, { force: true });
    }
  }

  get log(): Logger {
    return this.#log;
  }

  #read(path: string): SessionFile | undefined {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as SessionFile;
      if (parsed?.version !== 1 || !isStorageState(parsed.storageState)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  #ensureDirs(file: string): void {
    const root = join(this.dir, "..");
    mkdirSync(root, { recursive: true });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const ignore = join(this.dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "# Saved login sessions: never commit.\n*\n");
    let dir = this.dir;
    for (const part of file
      .slice(this.dir.length + 1)
      .split(/[\\/]/)
      .slice(0, -1)) {
      dir = join(dir, part);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
  }
}

// ── ensureProfile ─────────────────────────────────────────────────────────────

export interface LoginRequest {
  profileName: string;
  profile: AuthProfile;
  environment: string | undefined;
  worker: number | string;
}

/** What the injected login flow returns. It must not throw (a throw counts as login_failed). */
export type LoginResult =
  | { ok: true; storageState: StorageState }
  | { ok: false; reason: string; message: string };

export interface ValidateRequest extends LoginRequest {
  storageState: StorageState;
  check: NonNullable<AuthProfile["check"]>;
}

export interface EnsureProfileOptions {
  store: SessionStore;
  auth: Pick<AuthSettings, "profiles">;
  environment: string | undefined;
  /** The worker index (per-worker profiles get one session each). */
  worker: number | string;
  /** Runs the profile's login flow in a fresh browser and returns its storage state (AUTH-1 / LOOP-4). */
  runFlow: (request: LoginRequest) => Promise<LoginResult>;
  /** Quick check that a saved session still works (opens `check.url`). Only called when the profile has a `check`. */
  validate?: (request: ValidateRequest) => Promise<boolean>;
  /** Ignore any saved session and log in again. */
  force?: boolean;
}

export type EnsureResult =
  | {
      status: "ready";
      storageState: StorageState;
      /** saved = a valid saved session was reused; login = the flow ran. */
      source: "saved" | "login";
      expiresAt: string;
    }
  | {
      status: "failed";
      reason: "unknown_profile" | "login_failed" | "store_error";
      message: string;
    };

const inFlight = new Map<string, Promise<EnsureResult>>();

/**
 * The storage state a test with `auth: <profileName>` starts with: a valid saved
 * session, or a fresh one from `runFlow` (then saved). Never throws.
 */
export function ensureProfile(
  profileName: string,
  options: EnsureProfileOptions,
): Promise<EnsureResult> {
  const profile = options.auth.profiles?.[profileName];
  if (!profile) {
    return Promise.resolve({
      status: "failed",
      reason: "unknown_profile",
      message: `auth: ${profileName} is not a profile in the project settings.`,
    });
  }
  const key = options.store.keyFor(profileName, profile, options);
  const id = options.store.fileFor(key);
  const running = inFlight.get(id);
  if (running) return running;
  const promise = ensure(profileName, profile, key, options).finally(() => inFlight.delete(id));
  inFlight.set(id, promise);
  return promise;
}

async function ensure(
  profileName: string,
  profile: AuthProfile,
  key: SessionKey,
  options: EnsureProfileOptions,
): Promise<EnsureResult> {
  const { store } = options;
  const log = store.log;
  const where = { profile: profileName, environment: key.environment, worker: key.worker };
  const fingerprint = profileFingerprint(profile);
  const request: LoginRequest = {
    profileName,
    profile,
    environment: options.environment,
    worker: options.worker,
  };
  try {
    return await store.withLock(key, async () => {
      const saved = options.force ? { status: "none" as const } : store.load(key, fingerprint);
      if (saved.status === "valid") {
        let valid = true;
        if (profile.check && options.validate) {
          try {
            valid = await options.validate({
              ...request,
              storageState: saved.storageState,
              check: profile.check,
            });
          } catch {
            valid = false;
          }
        }
        if (valid) {
          log.info("auth: using saved session", where);
          return {
            status: "ready",
            storageState: saved.storageState,
            source: "saved",
            expiresAt: saved.expiresAt,
          };
        }
        log.info("auth: saved session no longer works; logging in again", where);
      } else if (saved.status !== "none") {
        log.info(`auth: saved session ${saved.status}; logging in again`, where);
      }

      let result: LoginResult;
      try {
        result = await options.runFlow(request);
      } catch (error) {
        result = {
          ok: false,
          reason: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (!result.ok) {
        log.warn("auth: login flow failed", { ...where, reason: result.reason });
        return {
          status: "failed",
          reason: "login_failed",
          message: `The login flow ${profile.flow} for profile ${profileName} failed: ${result.message}`,
        };
      }
      const { expiresAt } = store.save(key, result.storageState, {
        ttlMinutes: profile.ttlMinutes,
        fingerprint,
      });
      log.info("auth: logged in and saved the session", { ...where, expiresAt });
      return { status: "ready", storageState: result.storageState, source: "login", expiresAt };
    });
  } catch (error) {
    return {
      status: "failed",
      reason: "store_error",
      message: `Can't use the saved-session folder ${store.dir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
