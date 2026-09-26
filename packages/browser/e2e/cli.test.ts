import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostile, PASSWORD, seed, shop } from "./helpers.js";

// `snapshot` from the CLI (the dev tool), including the acceptance check: the
// checkout's card fields inside the iframe, with refs.

const bin = fileURLToPath(new URL("../../cli/bin/cli.js", import.meta.url));
let running: Awaited<ReturnType<typeof shop>>;

beforeAll(async () => {
  running = await shop();
  await seed(running.url);
});
afterAll(async () => {
  await running.stop();
});

// Async: the shop runs in this process, so a blocking spawn would starve it.
const cli = (...args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          status: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });

async function storageState(): Promise<string> {
  const response = await fetch(`${running.url}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "ada@example.com", password: PASSWORD }),
    redirect: "manual",
  });
  const cookie = /acme_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (!cookie) throw new Error("login failed");
  const file = join(mkdtempSync(join(tmpdir(), "state-")), "state.json");
  writeFileSync(
    file,
    JSON.stringify({
      cookies: [
        {
          name: "acme_session",
          value: cookie,
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    }),
  );
  return file;
}

describe("snapshot command", () => {
  it("shows the checkout card fields inside the iframe with refs", async () => {
    const result = await cli(
      "snapshot",
      `${running.url}/checkout?plan=pro`,
      "--storage-state",
      await storageState(),
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /- iframe "Secure card payment" \[e\d+\] \(frame 1: ".*\/pay\/frame"\)/,
    );
    expect(result.stdout).toMatch(/ {4}- textbox "Card number" \[e\d+\] placeholder=/);
    expect(result.stdout).toMatch(/ {4}- textbox "Expiry date" \[e\d+\]/);
    expect(result.stdout).toMatch(/ {4}- textbox "CVC" \[e\d+\]/);
    expect(result.stdout).toContain("Refused requests: none");
  });

  it("lists refused requests, and exits 2 on a setup problem", async () => {
    const pages = await hostile();
    try {
      // No project here, so the allowlist is the URL's own host (127.0.0.1).
      const result = await cli("snapshot", `${pages.url}/frame`);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("Refused requests (1):");
      expect(result.stdout).toContain(`iframe         ${pages.other}/framed`);
    } finally {
      await pages.stop();
    }
    const bad = await cli("snapshot", `${running.url}/pricing`, "--device", "nokia-3310");
    expect(bad.status).toBe(2);
    expect(bad.stdout).toContain('Unknown device preset "nokia-3310"');
  });
});
