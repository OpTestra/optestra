import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brand } from "@testament/brand";
import { loadProject } from "@testament/config/node";
import { parseTest } from "@testament/spec";
import { afterEach, describe, expect, it } from "vitest";
import "./index.js";
import { checkProfiles, checkTestAuth, testAuth } from "./profiles.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), "auth-config-"));
  dirs.push(dir);
  writeFileSync(join(dir, brand.configFileName), yaml);
  return loadProject(dir, { env: {} });
}

const BASE = `version: 1
project: { name: Shop, target: web }
environments:
  local: { baseUrl: "http://127.0.0.1:4100" }
`;

describe("auth and inbox config sections", () => {
  it("fills profile defaults and the inbox defaults", () => {
    const loaded = project(`${BASE}
auth:
  profiles:
    admin:
      flow: flows/login-admin.test.md
      params: { email: "{{data.admin_email}}" }
      check: { url: /dashboard }
    viewer:
      flow: flows/login-viewer.test.md
      reuse: shared
      ttlMinutes: 15
inbox:
  provider: mailpit
`);
    expect(loaded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(loaded.config.auth.profiles.admin).toEqual({
      flow: "flows/login-admin.test.md",
      params: { email: "{{data.admin_email}}" },
      check: { url: "/dashboard" },
      reuse: "per-worker",
      ttlMinutes: 60,
    });
    expect(loaded.config.auth.profiles.viewer).toMatchObject({ reuse: "shared", ttlMinutes: 15 });
    expect(loaded.config.auth.totp.minRemainingSeconds).toBe(5);
    expect(loaded.config.inbox).toMatchObject({
      provider: "mailpit",
      timeoutSeconds: 60,
      mailpit: { url: "http://127.0.0.1:8025", domain: "example.test" },
      mailosaur: { keySecret: "MAILOSAUR_API_KEY" },
      mailslurp: { keySecret: "MAILSLURP_API_KEY" },
    });
  });

  it("works with no auth or inbox settings at all", () => {
    const loaded = project(BASE);
    expect(loaded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(loaded.config.auth.profiles).toEqual({});
    expect(loaded.config.inbox.provider).toBe("none");
  });

  it("reports bad values with a path", () => {
    const loaded = project(`${BASE}
auth:
  profiles:
    none: { flow: flows/x.test.md }
    admin: { flow: flows/admin.md, reuse: sometimes }
inbox:
  provider: gmail
secrets:
  ADMIN_TOTP: { domains: [127.0.0.1], type: hotp }
`);
    const paths = loaded.diagnostics.filter((d) => d.code === "INVALID_VALUE").map((d) => d.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "auth.profiles.admin.flow",
        "auth.profiles.admin.reuse",
        "inbox.provider",
        "secrets.ADMIN_TOTP.type",
      ]),
    );
    expect(loaded.diagnostics.some((d) => d.path?.startsWith("auth.profiles"))).toBe(true);
  });

  it("accepts a totp secret declaration", () => {
    const loaded = project(`${BASE}
secrets:
  ADMIN_TOTP: { domains: [127.0.0.1], type: totp }
`);
    expect(loaded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(loaded.config.secrets.ADMIN_TOTP).toEqual({ domains: ["127.0.0.1"], type: "totp" });
  });
});

describe("a test's auth: value", () => {
  const auth = {
    profiles: {
      admin: {
        flow: "flows/login-admin.test.md",
        params: {},
        reuse: "per-worker" as const,
        ttlMinutes: 60,
      },
    },
  };
  const test = (value: string) =>
    parseTest(`---\nname: T\nauth: ${value}\n---\n\n1. Click "Save"\n`, "tests/t.test.md").spec;

  it("names a profile, none, or nothing", () => {
    expect(testAuth(undefined, auth)).toEqual({ kind: "default" });
    expect(testAuth("none", auth)).toEqual({ kind: "none" });
    expect(testAuth("admin", auth)).toMatchObject({ kind: "profile", name: "admin" });
    expect(testAuth("root", auth)).toEqual({ kind: "unknown", name: "root" });
  });

  it("reports an unknown profile with its position and the known ones", () => {
    expect(checkTestAuth(test("admin"), auth)).toEqual([]);
    expect(checkTestAuth(test("none"), auth)).toEqual([]);
    const [diagnostic] = checkTestAuth(test("root"), auth);
    expect(diagnostic).toMatchObject({
      code: "AUTH_PROFILE_UNKNOWN",
      severity: "error",
      file: "tests/t.test.md",
      line: 3,
      fix: "Use one of: admin, none, or add root under auth.profiles.",
    });
  });

  it("reports profiles whose login flow is missing", () => {
    expect(checkProfiles(auth, () => true)).toEqual([]);
    expect(checkProfiles(auth, () => false)).toMatchObject([
      { code: "AUTH_FLOW_MISSING", path: "auth.profiles.admin.flow" },
    ]);
  });
});
