import { spawn } from "node:child_process";

/**
 * Opens a local file with the system's default app (the browser for HTML).
 * Fixed programs, the path as a single argument, never a shell; never waits.
 */
export function openFile(path: string, platform: NodeJS.Platform = process.platform): void {
  const command = platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(command, [path], { detached: true, stdio: "ignore", shell: false });
  child.on("error", () => {});
  child.unref();
}
