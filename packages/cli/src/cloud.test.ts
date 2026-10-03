import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { ENV_PREFIX } from "@optestra/config";
import { afterAll, describe, expect, it } from "vitest";
import { credentialsFile, projectFiles, runCloudLogin } from "./commands/cloud.js";
import { runRunCommand } from "./commands/run.js";
import { shopProject } from "./shop-project.test-support.js";

// `run --cloud` and `cloud login` (CLI-2, CLOUD-2) against a stand-in cloud:
// what goes up, what starts, what prints and the exit code.

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../contract/fixtures/v1");
const RUN = "01M3EF2PM04CMHWHZ9D1V41QWH";
const URL_ = "https://cloud.example.test";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the cloud's sync API: records calls, plays a fixture run's events. */
function fakeCloud(fixture: string | null, final: "finished" | "failed" = "finished") {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const written = new Map<string, string>();
  const events = fixture
    ? readFileSync(join(fixtures, fixture, "events.ndjson"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { seq: number })
    : [];
  const handle = (state: string) => ({
    runId: RUN,
    state,
    message: final === "failed" ? "The cloud worker stopped answering." : null,
  });
  let polled = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = url.slice(`${URL_}/api/sync/`.length);
    const input = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, input });
    const auth = new Headers(init.headers).get("authorization");
    if (auth !== "Bearer t-ci-token")
      return new Response(JSON.stringify({ ok: false, error: { code: "signed_out" } }), {
        status: 401,
      });
    const ok = (value: unknown) => new Response(JSON.stringify({ ok: true, value }));
    switch (method) {
      case "sync.whoami":
        return ok({
          user: { id: "u", email: "ci@example.test", name: null },
          workspaces: [{ id: "w_1", name: "Mine", role: "owner", personal: true }],
        });
      case "sync.create":
        return ok({ projectId: "p_0123456789abcdef" });
      case "sync.files":
        return ok({ files: [] });
      case "sync.write":
        written.set(String(input.path), String(input.data));
        return ok({ status: "saved", version: "v" });
      case "sync.runStart":
        return ok(handle("queued"));
      case "sync.runEvents": {
        polled += 1;
        // First poll: everything, still live; second: done.
        if (polled === 1)
          return ok({ handle: handle("running"), events, live: true, artifactBase: "" });
        return ok({ handle: handle(final), events: [], live: false, artifactBase: "" });
      }
      default:
        return new Response(JSON.stringify({ ok: false, error: { code: "unknown_method" } }), {
          status: 404,
        });
    }
  }) as unknown as typeof fetch;
  return { calls, written, fetch: fetchImpl };
}

async function cloudRun(fixture: string | null, final: "finished" | "failed" = "finished") {
  const dir = shopProject("cli-cloud-");
  dirs.push(dir);
  writeFileSync(join(dir, ".env"), "SHOP_PASSWORD=planted-cli-cloud-secret\n");
  const cloud = fakeCloud(fixture, final);
  let out = "";
  const code = await runRunCommand(["tests/login.test.md"], { dir, cloud: true, cloudUrl: URL_ }, {
    cwd: dir,
    env: { [`${ENV_PREFIX}TOKEN`]: "t-ci-token", HOME: dir },
    stdout: (text) => {
      out += text;
    },
    fetch: cloud.fetch,
    pollMs: 1,
  } as Parameters<typeof runRunCommand>[2]);
  return { code, out, ...cloud, dir };
}

describe("run --cloud (CLI-2)", () => {
  it("uploads only the project's own files, runs exactly the chosen tests, prints and exits 0", async () => {
    const r = await cloudRun("all-passed");
    expect(r.code, r.out).toBe(0);
    expect([...r.written.keys()]).toContain(brand.configFileName);
    expect([...r.written.keys()]).toContain("tests/login.test.md");
    expect([...r.written.keys()].some((p) => p.startsWith(".env"))).toBe(false);
    expect([...r.written.values()].join("")).not.toContain(
      Buffer.from("planted-cli-cloud-secret").toString("base64"),
    );
    const start = r.calls.find((c) => c.method === "sync.runStart")?.input;
    expect(start).toMatchObject({
      workspaceId: "w_1",
      trigger: "cli",
      run: {
        projectId: "p_0123456789abcdef",
        selection: { kind: "tests", paths: ["tests/login.test.md"] },
      },
    });
    expect(r.out).toMatch(/in the cloud/);
    expect(r.out).toMatch(/exit code 0/);
    // The link to the cloud copy is kept for next time.
    expect(statSync(join(r.dir, brand.dataDirName, "cloud.json")).isFile()).toBe(true);
  });

  it("exits 1 for a failed run and 2 when the cloud couldn't run it", async () => {
    expect((await cloudRun("failed-product-bug")).code).toBe(1);
    const broken = await cloudRun(null, "failed");
    expect(broken.code).toBe(2);
    expect(broken.out).toMatch(/stopped answering/);
  });

  it("says how to sign in when there is no token", async () => {
    const dir = shopProject("cli-cloud-");
    dirs.push(dir);
    let out = "";
    const code = await runRunCommand(
      [],
      { dir, cloud: true, cloudUrl: URL_ },
      {
        cwd: dir,
        env: { HOME: dir },
        stdout: (text) => {
          out += text;
        },
      },
    );
    expect(code).toBe(2);
    expect(out).toMatch(/cloud login/);
  });

  it("never uploads secrets, saved logins or run folders", () => {
    const dir = shopProject("cli-cloud-files-");
    dirs.push(dir);
    writeFileSync(join(dir, ".env"), "X=1\n");
    writeFileSync(join(dir, ".env.example"), "X=\n");
    const files = projectFiles(dir);
    expect(files).toContain(".env.example");
    expect(files).not.toContain(".env");
    expect(files.some((f) => f.startsWith(`${brand.dataDirName}/`))).toBe(false);
  });
});

describe("cloud login", () => {
  it("signs in through the browser and a listener on 127.0.0.1, keeping the token for the user only", async () => {
    const home = mkdtempSync(join(tmpdir(), "cli-login-"));
    dirs.push(home);
    let out = "";
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
    const code = await runCloudLogin(
      { cloudUrl: URL_ },
      {
        cwd: home,
        env,
        stdout: (text) => {
          out += text;
        },
        // The "browser": signs in and comes back to the listener with a code.
        openBrowser: (signIn) => {
          const at = new URL(signIn);
          const port = at.searchParams.get("port");
          const state = at.searchParams.get("state");
          expect(at.searchParams.get("challenge")).toMatch(/^[\w-]{43}$/);
          void fetch(`http://127.0.0.1:${port}/callback?code=c-${"x".repeat(30)}&state=${state}`);
        },
        fetch: (async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as { code: string; verifier: string };
          expect(body.verifier).toMatch(/^[\w-]{43}$/);
          return new Response(
            JSON.stringify({
              ok: true,
              value: {
                token: "t-from-login",
                expiresAt: "2027-01-01T00:00:00.000Z",
                user: { id: "u", email: "me@example.test", name: null },
              },
            }),
          );
        }) as unknown as typeof fetch,
      },
    );
    expect(code, out).toBe(0);
    const file = credentialsFile(env);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      url: URL_,
      token: "t-from-login",
    });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(out).toContain("me@example.test");
  });
});
