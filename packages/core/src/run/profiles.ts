import {
  type AuthProfile,
  type AuthSettings,
  ensureProfile,
  type LoginResult,
  type SessionStore,
  type StorageState,
} from "@testament/auth";
import type { Session } from "@testament/browser";
import type { Config } from "@testament/config";
import type { SecretValue } from "@testament/config/node";
import type { StepResult } from "@testament/contract";
import { type Recording, routeOf } from "@testament/recording";
import { readRecording, recordingPath } from "@testament/recording/node";
import type { ExpandedTest } from "@testament/spec";
import { loadTest } from "@testament/spec/node";
import { resolve } from "node:path";
import type { TestInbox } from "../author/inbox.js";
import { replayAttempt } from "./replay.js";
import type { PrepareOutcome, ReplayOptions, ReplayResult } from "./types.js";

// Auth profiles in runs (SEC-3, AUTH-1). A test with `auth: <profile>` starts
// logged in: a saved session is reused when it is young enough, made for this
// profile definition and still passes the profile's `check` (opened in the
// test's own session, after its setup hooks); otherwise the profile's login
// flow is replayed like a test (its own recording; authored if unrecorded) in a
// separate session with no trace, video or HAR, and its storage state saved.
// The test's trace therefore never contains the login.

/** Blocked reasons that are "ours" (the app may be fine): kept as they are. */
const OUR_REASONS = new Set([
  "missing_secret",
  "inbox_unavailable",
  "disallowed_domain",
  "ai_unavailable",
  "budget_exceeded",
  "app_down",
  "captcha",
  "aborted",
  "config_error",
]);

export interface ProfileLoginOptions {
  name: string;
  profile: AuthProfile;
  auth: Pick<AuthSettings, "profiles">;
  store: SessionStore;
  environment: string;
  worker: number;
  /** The test's own session (fresh, after its setup hooks). */
  session: Pick<Session, "useStorageState" | "act" | "check" | "url">;
  /** Index for the login's step (after the test's own steps: it isn't one of them). */
  stepIndex: number;
  /** Replays the profile's flow in a fresh login session; returns its result and storage state. */
  runFlow: () => Promise<
    | { ok: true; result: ReplayResult; storageState: StorageState }
    | { ok: false; result?: ReplayResult; reason: string; message: string }
  >;
  now?: () => Date;
}

/** Does a saved session still work? Opens `check.url` and checks where it landed (and its text). */
export async function sessionWorks(
  session: ProfileLoginOptions["session"],
  state: StorageState,
  check: NonNullable<AuthProfile["check"]>,
): Promise<boolean> {
  await session.useStorageState(state);
  const outcome = await session.act({ type: "goto", url: check.url });
  if (outcome.status !== "ok") return false;
  let wanted: string;
  try {
    wanted = new URL(check.url, session.url).pathname;
  } catch {
    return false;
  }
  // Redirected elsewhere (typically to the login page): the session no longer works.
  if (routeOf(session.url) !== routeOf(wanted)) return false;
  if (!check.text) return true;
  const seen = await session.check(
    {
      type: "text",
      target: { kind: "css", selector: "body" },
      match: "contains",
      value: check.text,
    },
    { timeoutMs: 2_000 },
  );
  return seen.status === "passed" && seen.passed;
}

/** The login as one `flow` step of the test's attempt. */
function loginStep(
  options: ProfileLoginOptions,
  result: ReplayResult | undefined,
  status: StepResult["status"],
  startedAt: Date,
  error: string | null,
): StepResult {
  return {
    index: options.stepIndex,
    key: `auth:${options.name}`,
    text: `auth: ${options.name} (logs in with ${options.profile.flow})`,
    kind: "flow",
    status,
    recovery: status === "passed" ? "replay" : "none",
    locator: null,
    postState: null,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    settledMs: null,
    screenshots: { before: null, after: null },
    error,
    checkIds: [],
    modelCallIds: (result?.modelCalls ?? []).map((c) => c.id),
    decisionIds: [],
    healIds: (result?.heals ?? []).map((h) => h.id),
  };
}

/** The test's login: a saved session, or the profile's flow. Never throws. */
export async function profileLogin(options: ProfileLoginOptions): Promise<PrepareOutcome> {
  const startedAt = options.now?.() ?? new Date();
  let flow: Awaited<ReturnType<ProfileLoginOptions["runFlow"]>> | undefined;
  const ensured = await ensureProfile(options.name, {
    store: options.store,
    auth: options.auth,
    environment: options.environment,
    worker: options.worker,
    validate: ({ storageState, check }) => sessionWorks(options.session, storageState, check),
    runFlow: async (): Promise<LoginResult> => {
      flow = await options.runFlow();
      return flow.ok
        ? { ok: true, storageState: flow.storageState }
        : { ok: false, reason: flow.reason, message: flow.message };
    },
  });
  const result = flow?.result;
  const extras = {
    ...(result && result.status !== "passed" ? { observations: result.observations } : {}),
    flowPath: options.profile.flow,
    modelCalls: result?.modelCalls ?? [],
    heals: (result?.heals ?? []).map((h) => ({ ...h, stepIndex: options.stepIndex })),
  };
  if (ensured.status === "ready") {
    try {
      await options.session.useStorageState(ensured.storageState);
    } catch (error) {
      return {
        status: "blocked",
        reason: "login_failed",
        message: `auth: ${options.name}: the saved session couldn't be loaded: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (ensured.source === "saved")
      return {
        status: "ready",
        message: "",
        logs: [
          `auth: ${options.name}: reused the saved session (valid until ${ensured.expiresAt}).`,
        ],
      };
    return {
      status: "ready",
      message: "",
      step: loginStep(options, result, "passed", startedAt, null),
      logs: [
        `auth: ${options.name}: logged in with ${options.profile.flow} and saved the session.`,
      ],
      ...extras,
    };
  }

  if (ensured.reason === "unknown_profile")
    return { status: "blocked", reason: "config_error", message: ensured.message };
  if (ensured.reason === "store_error")
    return { status: "blocked", reason: "login_failed", message: ensured.message };
  // The login flow didn't complete.
  const why = flow && !flow.ok ? flow : undefined;
  const headline = `auth: ${options.name}: logging in with ${options.profile.flow} failed: ${why?.message ?? ensured.message}`;
  if (why?.reason === "failed")
    // The app's login is broken: the test fails (same rule as a failing Use: flow).
    return {
      status: "failed",
      message: headline,
      step: loginStep(options, result, "failed", startedAt, why.message),
      ...extras,
    };
  return {
    status: "blocked",
    reason: why && OUR_REASONS.has(why.reason) ? why.reason : "login_failed",
    message: headline,
    step: loginStep(options, result, "blocked", startedAt, why?.message ?? ensured.message),
    ...extras,
  };
}

/** A flow's test id and path, for profiles: `flow` is relative to the tests folder. */
export function profileFlowPath(testsDirRelative: string, flow: string): string {
  const dir = testsDirRelative.replace(/\\/g, "/").replace(/\/+$/, "");
  return dir && dir !== "." ? `${dir}/${flow}` : flow;
}

export type ProfileFlowResult =
  | { ok: true; result: ReplayResult; storageState: StorageState }
  | { ok: false; result?: ReplayResult; reason: string; message: string };

export interface ProfileFlowOptions {
  projectDir: string;
  config: Config;
  environment: string;
  profile: AuthProfile;
  /** Seed for the flow's generated values. */
  seed: string;
  emailDomain?: string | undefined;
  /** A fresh login session (no trace, video or HAR), opened with these extra secrets. */
  openSession: (extraSecrets: Readonly<Record<string, SecretValue>>) => Promise<Session>;
  /** The flow's own test inbox (a flow may read an email: a magic-link login). */
  inbox?: () => TestInbox | undefined;
  replay: Omit<
    ReplayOptions,
    "test" | "recording" | "session" | "attempt" | "timeoutMs" | "emit" | "inbox" | "screenshots"
  >;
  onLog?: (message: string) => void;
  /** Keeps steps the flow authored (merge into the flow's recording and write it). */
  saveAuthored: (
    flow: ExpandedTest,
    previous: Recording | undefined,
    authored: ReplayResult["authored"],
    paths: { test: string; recording: string },
  ) => void;
}

/**
 * Replays a profile's login flow like a test (REP-3; authors unrecorded steps in
 * normal mode) in its own session, and returns its storage state when it passed.
 */
export async function replayProfileFlow(options: ProfileFlowOptions): Promise<ProfileFlowResult> {
  const { config } = options;
  const testsDirRelative = config.tests?.dir ?? "tests";
  const path = profileFlowPath(testsDirRelative, options.profile.flow);
  const loaded = await loadTest(options.projectDir, path, config, {
    environment: options.environment,
    seed: options.seed,
    emailDomain: options.emailDomain,
    params: options.profile.params,
  });
  if (!loaded)
    return { ok: false, reason: "config_error", message: `The login flow ${path} doesn't exist.` };
  const problems = loaded.diagnostics.filter((d) => d.severity === "error");
  if (problems.length > 0)
    return {
      ok: false,
      reason: "config_error",
      message: `The login flow ${path} has problems: ${problems.map((d) => `${d.code}: ${d.message}`).join(" ")}`,
    };
  const flow = loaded.expanded;
  const file = recordingPath(resolve(options.projectDir, testsDirRelative), flow.id);
  const stored = readRecording(file);
  const recording = stored?.ok ? stored.recording : undefined;
  const inbox = options.inbox?.();
  let login: Session;
  try {
    login = await options.openSession(inbox?.secrets ?? {});
  } catch (error) {
    return {
      ok: false,
      reason: "config_error",
      message: `The browser could not start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let result: ReplayResult;
  let storageState: StorageState | undefined;
  try {
    result = await replayAttempt({
      ...options.replay,
      test: flow,
      recording,
      session: login,
      attempt: 1,
      inbox,
      screenshots: false,
      timeoutMs: (flow.timeout ?? config.run.timeoutSeconds) * 1000,
      emit: (event) => {
        if (event.type === "log") options.onLog?.(`auth (${path}): ${event.message}`);
      },
    });
    if (result.status === "passed") storageState = await login.storageState();
  } finally {
    await login.close();
  }
  if (result.authored.steps.length > 0 || result.authored.checks.length > 0) {
    const now = readRecording(file);
    options.saveAuthored(flow, now?.ok ? now.recording : undefined, result.authored, {
      test: path,
      recording: file,
    });
  }
  if (storageState) return { ok: true, result, storageState };
  if (result.status === "blocked")
    return {
      ok: false,
      result,
      reason: result.blocked?.reason ?? "login_failed",
      message: result.blocked?.message ?? "the login flow couldn't run",
    };
  return {
    ok: false,
    result,
    reason: "failed",
    message: result.failure?.headline ?? "the login flow failed",
  };
}
