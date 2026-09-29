import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { execPathIsNode, isNodeScript, nodeOnPath, nodeRuntime } from "./node-runtime.js";

// Which Node runs JS tools (PERF-0): this process when it is Node; inside the
// packaged desktop app (Electron) a node on PATH, else the app in Node mode.

const dir = mkdtempSync(join(tmpdir(), "node-runtime-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const electron = { ...process.versions, electron: "39.0.0" } as NodeJS.ProcessVersions;

describe("nodeRuntime", () => {
  it("is this process under plain Node", () => {
    expect(execPathIsNode()).toBe(true);
    expect(nodeRuntime()).toEqual({ command: process.execPath, env: {}, how: "self" });
  });

  it("uses the node given, whatever runs the engine", () => {
    expect(nodeRuntime({ node: "/opt/node/bin/node", versions: electron })).toEqual({
      command: "/opt/node/bin/node",
      env: {},
      how: "option",
    });
  });

  it("inside the desktop app: a node on PATH, else the app itself in Node mode", () => {
    expect(execPathIsNode(electron)).toBe(false);
    const bin = join(dir, "bin");
    // This OS's own name for it (node.exe on Windows).
    const own = join(dir, process.platform === "win32" ? "node.exe" : "node");
    writeFileSync(own, "");
    const onPath = nodeRuntime({ versions: electron, env: { PATH: dir } });
    expect(onPath).toEqual({ command: own, env: {}, how: "path" });
    expect(nodeOnPath({ PATH: bin })).toBeNull();
    expect(nodeRuntime({ versions: electron, env: { PATH: bin } })).toEqual({
      command: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      how: "electron",
    });
  });

  it("follows Windows rules on any OS: `;` between folders, `Path`, node.exe only, quoted folders", () => {
    const files = new Set(["C:\\Program Files\\nodejs\\node.exe", "C:\\tools\\node.cmd"]);
    const has = (path: string) => files.has(path);
    const env = { Path: 'C:\\tools;"C:\\Program Files\\nodejs";C:\\Windows' };
    expect(nodeOnPath(env, "win32", has)).toBe("C:\\Program Files\\nodejs\\node.exe");
    // node.cmd needs a shell: not used.
    expect(nodeOnPath({ Path: "C:\\tools" }, "win32", has)).toBeNull();
    expect(nodeRuntime({ versions: electron, env, platform: "win32", isFileAt: has })).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      env: {},
      how: "path",
    });
  });

  it("follows POSIX rules on any OS: `:` between folders, plain `node`", () => {
    const has = (path: string) => path === "/opt/homebrew/bin/node";
    expect(nodeOnPath({ PATH: "/usr/bin:/opt/homebrew/bin" }, "darwin", has)).toBe(
      "/opt/homebrew/bin/node",
    );
    expect(nodeOnPath({ PATH: "/usr/bin" }, "linux", has)).toBeNull();
  });
});

describe("isNodeScript", () => {
  it("knows .js files and npm installs that start with a node #! line", () => {
    const cli = join(dir, "claude");
    writeFileSync(cli, "#!/usr/bin/env node\nconsole.log(1)\n");
    chmodSync(cli, 0o755);
    const native = join(dir, "codex");
    writeFileSync(native, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00]));
    const shell = join(dir, "tool");
    writeFileSync(shell, "#!/bin/sh\necho hi\n");
    expect(isNodeScript(join(dir, "x.mjs"))).toBe(true);
    expect(isNodeScript(cli)).toBe(true);
    expect(isNodeScript(native)).toBe(false);
    expect(isNodeScript(shell)).toBe(false);
    expect(isNodeScript(join(dir, "missing"))).toBe(false);
  });
});
