import type { Diagnostic } from "@testament/config";
import type { Range, TestSpec } from "@testament/spec";
import type { AuthProfile, AuthSettings } from "./section.js";

/** How a test starts: logged out, with a named profile, or as the test itself says (no `auth:`). */
export type TestAuth =
  | { kind: "default" }
  | { kind: "none" }
  | { kind: "profile"; name: string; profile: AuthProfile }
  | { kind: "unknown"; name: string };

export type AuthDiagnosticCode = "AUTH_PROFILE_UNKNOWN" | "AUTH_FLOW_MISSING";

export interface AuthDiagnostic extends Omit<Diagnostic, "code"> {
  code: AuthDiagnosticCode;
  range?: Range;
}

type WithAuth = Pick<AuthSettings, "profiles"> | undefined;

/** What `auth:` in a test's frontmatter means for this project. */
export function testAuth(value: string | undefined, auth: WithAuth): TestAuth {
  if (value === undefined) return { kind: "default" };
  if (value === "none") return { kind: "none" };
  const profile = auth?.profiles?.[value];
  return profile ? { kind: "profile", name: value, profile } : { kind: "unknown", name: value };
}

/** AUTH_PROFILE_UNKNOWN when a test names a profile the project doesn't have. */
export function checkTestAuth(spec: TestSpec, auth: WithAuth): AuthDiagnostic[] {
  const resolved = testAuth(spec.frontmatter.auth, auth);
  if (resolved.kind !== "unknown") return [];
  const known = Object.keys(auth?.profiles ?? {});
  const range = spec.fields?.auth;
  return [
    {
      code: "AUTH_PROFILE_UNKNOWN",
      severity: "error",
      file: spec.path,
      ...(range && { line: range.start.line, range }),
      path: "auth",
      message: `auth: ${resolved.name} is not a profile in the project settings.`,
      fix: known.length
        ? `Use one of: ${[...known, "none"].join(", ")}, or add ${resolved.name} under auth.profiles.`
        : `Add it under auth.profiles in the project file (with the flow that logs in), or write auth: none.`,
    },
  ];
}

/** AUTH_FLOW_MISSING for profiles whose login flow file doesn't exist. */
export function checkProfiles(
  auth: WithAuth,
  flowExists: (flow: string) => boolean,
  file?: string,
): AuthDiagnostic[] {
  return Object.entries(auth?.profiles ?? {}).flatMap(([name, profile]) =>
    flowExists(profile.flow)
      ? []
      : [
          {
            code: "AUTH_FLOW_MISSING" as const,
            severity: "error" as const,
            ...(file && { file }),
            path: `auth.profiles.${name}.flow`,
            message: `Profile ${name} logs in with ${profile.flow}, which doesn't exist.`,
            fix: `Create ${profile.flow} in the tests folder (kind: flow), or fix the path.`,
          },
        ],
  );
}
