import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchEnv, splitCommand } from "./exec.js";
import { type LaunchEnv, launchPlan, windowsLookup } from "./launch.js";

// How run: hooks start on each platform (AUT-10). Windows can't spawn a script
// file (EFTYPE): each kind goes to its own interpreter, never through a shell
// except cmd.exe for a batch file. Tested here with the platform stubbed, so
// the Windows rules are checked on every machine.

const NODE_WIN = "C:\\Program Files\\nodejs\\node.exe";
const win = (overrides: Partial<LaunchEnv> = {}): LaunchEnv => ({
  platform: "win32",
  execPath: NODE_WIN,
  comSpec: "C:\\Windows\\System32\\cmd.exe",
  findOnPath: (name) =>
    ({
      pnpm: "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\pnpm.cmd",
      psql: "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe",
      node: NODE_WIN,
    })[name],
  firstLine: () => "#!/usr/bin/env node",
  ...overrides,
});
const posix: LaunchEnv = { platform: "linux", execPath: "/usr/local/bin/node" };
const PROJECT = "C:\\Users\\Ada Lovelace\\my shop";

describe("launchPlan on Windows", () => {
  it("runs JavaScript and TypeScript with this Node: no EFTYPE, spaces kept as one argument", () => {
    for (const ext of [".js", ".mjs", ".cjs", ".ts"]) {
      const file = `${PROJECT}\\scripts\\seed data${ext}`;
      expect(launchPlan(file, ["--plan", "pro plan"], win(), true)).toEqual({
        ok: true,
        command: NODE_WIN,
        args: [file, "--plan", "pro plan"],
        via: "node",
      });
    }
  });

  it("runs a batch file through cmd.exe /d /s /c with every word quoted that needs it", () => {
    const file = `${PROJECT}\\scripts\\seed (local).cmd`;
    expect(launchPlan(file, ["pro plan", "--count=3", "x"], win(), true)).toEqual({
      ok: true,
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `""C:\\Users\\Ada Lovelace\\my shop\\scripts\\seed (local).cmd" "pro plan" "--count=3" x"`,
      ],
      windowsVerbatimArguments: true,
      via: "cmd",
    });
  });

  it("refuses batch arguments cmd.exe would expand or split", () => {
    const file = `${PROJECT}\\scripts\\seed.bat`;
    for (const bad of ["%PATH%", "a&b", "a|b", 'say "hi"', "!x!", "a^b", "a>b", "line\nbreak"]) {
      const plan = launchPlan(file, [bad], win(), true);
      expect(plan.ok, bad).toBe(false);
      if (!plan.ok) expect(plan.message).toContain("Use a .js script");
    }
  });

  it("finds a program's .cmd shim on the PATH (pnpm) and an .exe (psql)", () => {
    expect(launchPlan("pnpm", ["run", "seed"], win(), false)).toMatchObject({
      via: "cmd",
      args: [
        "/d",
        "/s",
        "/c",
        `""C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\pnpm.cmd" run seed"`,
      ],
    });
    expect(launchPlan("psql", ["-c", "SELECT 1"], win(), false)).toEqual({
      ok: true,
      command: "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe",
      args: ["-c", "SELECT 1"],
      via: "direct",
    });
    // Not on the PATH: started as it is, so the error says it isn't installed.
    expect(launchPlan("mysql", [], win(), false)).toMatchObject({
      via: "direct",
      command: "mysql",
    });
  });

  it("runs .ps1 with PowerShell, follows a node shebang, and says what it can't start", () => {
    expect(launchPlan(`${PROJECT}\\seed.ps1`, ["a b"], win(), true)).toEqual({
      ok: true,
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        `${PROJECT}\\seed.ps1`,
        "a b",
      ],
      via: "powershell",
    });
    expect(launchPlan(`${PROJECT}\\scripts\\seed`, [], win(), true)).toMatchObject({
      via: "node",
      command: NODE_WIN,
    });
    const sh = launchPlan(`${PROJECT}\\scripts\\seed.sh`, [], win(), true);
    expect(sh).toMatchObject({
      ok: false,
      message: expect.stringContaining("Windows has no /bin/sh"),
    });
    const bash = launchPlan(
      `${PROJECT}\\scripts\\seed`,
      [],
      win({ firstLine: () => "#!/bin/bash" }),
      true,
    );
    expect(bash).toMatchObject({ ok: false, message: expect.stringContaining('"/bin/bash"') });
    expect(launchPlan(`${PROJECT}\\tools\\seed.exe`, ["x"], win(), true)).toMatchObject({
      via: "direct",
    });
  });
});

describe("launchPlan elsewhere", () => {
  it("runs JavaScript with Node, .sh with /bin/sh, other files and programs directly", () => {
    expect(launchPlan("/srv/my shop/scripts/seed.js", ["a b"], posix, true)).toEqual({
      ok: true,
      command: "/usr/local/bin/node",
      args: ["/srv/my shop/scripts/seed.js", "a b"],
      via: "node",
    });
    expect(launchPlan("/srv/shop/seed.sh", ["x"], posix, true)).toMatchObject({
      command: "/bin/sh",
      args: ["/srv/shop/seed.sh", "x"],
    });
    expect(launchPlan("/srv/shop/seed", [], posix, true)).toMatchObject({ via: "direct" });
    expect(launchPlan("pnpm", ["run", "seed"], posix, false)).toEqual({
      ok: true,
      command: "pnpm",
      args: ["run", "seed"],
      via: "direct",
    });
    expect(launchPlan("/srv/shop/seed.cmd", [], posix, true)).toMatchObject({ ok: false });
    expect(launchPlan("/srv/shop/seed.ps1", [], posix, true)).toMatchObject({ command: "pwsh" });
  });
});

describe("splitCommand → launchPlan", () => {
  it("keeps quoted words with spaces as one argument end to end", () => {
    const words = splitCommand(`"scripts/seed data.js" --name "Ada Lovelace" 'it''s'`);
    expect(words).toEqual(["scripts/seed data.js", "--name", "Ada Lovelace", "its"]);
  });
});

describe("windowsLookup", () => {
  it("tries PATHEXT on each PATH folder, in order", () => {
    const files = new Set(["C:\\npm\\pnpm.cmd", "C:\\node\\node.exe"]);
    const find = windowsLookup(
      { Path: "C:\\node;C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      (p) => files.has(p),
      (dir, name) => `${dir}\\${name}`,
    );
    expect(find("pnpm")).toBe("C:\\npm\\pnpm.cmd");
    expect(find("node")).toBe("C:\\node\\node.exe");
    expect(find("missing")).toBeUndefined();
  });
});

describe("this machine as Windows (process.platform stubbed)", () => {
  const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  afterEach(() => Object.defineProperty(process, "platform", real));

  it("plans a .js hook through Node and a pnpm shim through cmd.exe, never the script itself", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const bin = mkdtempSync(join(tmpdir(), "win-path-"));
    try {
      mkdirSync(join(bin, "npm"));
      writeFileSync(join(bin, "npm", "pnpm.cmd"), "@echo off");
      const env = launchEnv({
        Path: join(bin, "npm"),
        PATHEXT: ".EXE;.CMD",
        ComSpec: "C:\\cmd.exe",
      });
      expect(env.platform).toBe("win32");
      const script = launchPlan("C:\\shop\\scripts\\seed.js", ["a b"], env, true);
      expect(script).toMatchObject({ via: "node", command: process.execPath });
      const shim = launchPlan("pnpm", ["seed"], env, false);
      expect(shim).toMatchObject({
        via: "cmd",
        command: "C:\\cmd.exe",
        windowsVerbatimArguments: true,
      });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
