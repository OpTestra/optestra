import { type AuthProfile, SessionStore } from "@testament/auth";
import type { Session } from "@testament/browser";
import type { Config } from "@testament/config";
import { createLogger, defaultRedactor } from "@testament/config/node";
import { writeRecording } from "@testament/recording/node";
import type { TestInbox } from "../author/inbox.js";
import type { StopReason } from "../author/types.js";
import { type ProfileFlowOptions, profileLogin, replayProfileFlow } from "./profiles.js";
import { mergeRecording } from "./runner.js";

// The CLI's `author` command (and other single-test authoring) for a test with
// `auth: <profile>`: the same login as a run (SEC-3), a saved session or the
// profile's flow, before the start page. Steps the flow authors go into the
// flow's own recording.

const STOP_REASONS = new Set<StopReason>([
  "missing_secret",
  "inbox_unavailable",
  "disallowed_domain",
  "ai_unavailable",
  "budget_exceeded",
]);

export interface AuthoringLoginOptions {
  projectDir: string;
  config: Config;
  environment: string;
  name: string;
  profile: AuthProfile;
  /** The test's session (after its setup hooks). */
  session: Session;
  openSession: ProfileFlowOptions["openSession"];
  replay: ProfileFlowOptions["replay"];
  emailDomain?: string | undefined;
  inbox?: () => TestInbox | undefined;
  meta: { engineVersion: string; browser: string; device: string };
  onLog?: (message: string) => void;
}

/** A `prepare` for `authorTest`: logs the test in, or says why it can't. */
export function authoringLogin(
  options: AuthoringLoginOptions,
): () => Promise<{ ok: true } | { ok: false; reason: StopReason; message: string }> {
  return async () => {
    const store = new SessionStore({
      projectDir: options.projectDir,
      logger: createLogger({ level: "warn", redactor: defaultRedactor }),
    });
    const outcome = await profileLogin({
      name: options.name,
      profile: options.profile,
      auth: { profiles: { [options.name]: options.profile } },
      store,
      environment: options.environment,
      worker: 0,
      session: options.session,
      stepIndex: 0,
      runFlow: () =>
        replayProfileFlow({
          projectDir: options.projectDir,
          config: options.config,
          environment: options.environment,
          profile: options.profile,
          seed: `author:auth:${options.name}:${Date.now().toString(36)}`,
          emailDomain: options.emailDomain,
          openSession: options.openSession,
          ...(options.inbox ? { inbox: options.inbox } : {}),
          replay: options.replay,
          ...(options.onLog ? { onLog: options.onLog } : {}),
          saveAuthored: (flow, previous, authored, paths) =>
            writeRecording(
              paths.recording,
              mergeRecording(flow, previous, authored, {
                testPath: paths.test,
                target: options.config.project?.target ?? "web",
                engineVersion: options.meta.engineVersion,
                browser: options.meta.browser,
                device: options.meta.device,
                environment: options.environment,
                now: new Date().toISOString(),
              }),
            ),
        }),
    });
    for (const line of outcome.logs ?? []) options.onLog?.(line);
    if (outcome.status === "ready") return { ok: true };
    const reason =
      outcome.status === "blocked" && STOP_REASONS.has(outcome.reason as StopReason)
        ? (outcome.reason as StopReason)
        : "setup_failed";
    return { ok: false, reason, message: outcome.message };
  };
}
