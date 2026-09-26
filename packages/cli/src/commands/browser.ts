import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { findProject, loadProject, projectFile } from "@testament/config/node";
import type { Command } from "commander";
import type { CommandIo } from "./config.js";

// Browser commands. The harness (and Playwright) is imported only when one of
// these runs, so every other command starts without loading a browser driver.

export interface SnapshotCommandOptions {
  env?: string;
  device?: string;
  browser?: string;
  screenshot?: string;
  storageState?: string;
  dir?: string;
  json?: boolean;
}

export interface InstallBrowsersOptions {
  firefox?: boolean;
  webkit?: boolean;
  all?: boolean;
  withDeps?: boolean;
}

const BROWSERS = ["chromium", "firefox", "webkit"] as const;
type BrowserName = (typeof BROWSERS)[number];

interface Target {
  url: string;
  allowedDomains: string[];
  baseUrl: string | undefined;
}

/** The URL to open and the allowlist: the environment's when a project is found, else the URL's host. */
function target(url: string, options: SnapshotCommandOptions, io: CommandIo): Target | string {
  const dir = options.dir ? resolve(io.cwd, options.dir) : (findProject(io.cwd) ?? io.cwd);
  if (existsSync(projectFile(dir))) {
    const loaded = loadProject(dir, { environment: options.env, env: io.env });
    const settings = loaded.environment?.settings;
    if (settings) {
      let absolute: URL;
      try {
        absolute = settings.baseUrl ? new URL(url, settings.baseUrl) : new URL(url);
      } catch {
        return `"${url}" is not a URL, and the environment has no baseUrl to resolve it against.`;
      }
      return {
        url: absolute.href,
        allowedDomains: settings.allowedDomains,
        baseUrl: settings.baseUrl,
      };
    }
    if (options.env) return `Environment "${options.env}" was not found in ${projectFile(dir)}.`;
  } else if (options.env) {
    return `--env needs a project: no project file in ${dir}.`;
  }
  try {
    const parsed = new URL(url);
    return { url: parsed.href, allowedDomains: [parsed.hostname], baseUrl: undefined };
  } catch {
    return `"${url}" is not a URL. Use a full http(s) URL, or run inside a project with a baseUrl.`;
  }
}

/** `snapshot <url>`: prints what the agent would see. Exit 0 ok, 1 page not shown, 2 setup problem. */
export async function runSnapshotCommand(
  url: string,
  options: SnapshotCommandOptions,
  io: CommandIo,
): Promise<number> {
  const resolved = target(url, options, io);
  if (typeof resolved === "string") {
    io.stdout(`${resolved}\n`);
    return 2;
  }
  if (options.browser && !BROWSERS.includes(options.browser as BrowserName)) {
    io.stdout(`Unknown browser "${options.browser}". Use ${BROWSERS.join(", ")}.\n`);
    return 2;
  }
  let storageState: unknown;
  if (options.storageState) {
    try {
      storageState = JSON.parse(readFileSync(resolve(io.cwd, options.storageState), "utf8"));
    } catch (error) {
      io.stdout(
        `Could not read the storage state file: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
  }
  const harness = await import("@testament/browser");
  let session: Awaited<ReturnType<typeof harness.openSession>>;
  try {
    session = await harness.openSession({
      browser: (options.browser as BrowserName | undefined) ?? "chromium",
      allowedDomains: resolved.allowedDomains,
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
      ...(options.device ? { device: options.device } : {}),
      ...(storageState
        ? { storageState: storageState as import("@testament/browser").StorageState }
        : {}),
    });
  } catch (error) {
    const fix = error instanceof harness.BrowserSetupError ? `\nFix: ${error.fix}` : "";
    io.stdout(`${error instanceof Error ? error.message : String(error)}${fix}\n`);
    return 2;
  }
  try {
    const opened = await session.act({ type: "goto", url: resolved.url });
    const observation = await session.observe();
    const refused = session.refusals();
    if (options.screenshot) {
      const shot = await session.screenshot();
      if (shot.status === "ok") writeFileSync(resolve(io.cwd, options.screenshot), shot.bytes);
    }
    if (options.json) {
      io.stdout(`${JSON.stringify({ outcome: opened, observation, refused }, null, 2)}\n`);
    } else {
      if (opened.status !== "ok") {
        io.stdout(
          `Could not open ${resolved.url}: ${opened.status}${opened.message ? ` (${opened.message})` : ""}\n\n`,
        );
      }
      io.stdout(`${harness.renderForModel(observation)}\n`);
      io.stdout(`\nAllowed domains: ${resolved.allowedDomains.join(", ") || "(none)"}\n`);
      if (refused.length === 0) io.stdout("Refused requests: none\n");
      else {
        io.stdout(`Refused requests (${refused.length}):\n`);
        for (const r of refused)
          io.stdout(`  ${r.type.padEnd(14)} ${r.url}${r.frame ? `  (from ${r.frame})` : ""}\n`);
      }
    }
    return opened.status === "ok" ? 0 : 1;
  } finally {
    await session.close();
  }
}

export async function runInstallBrowsersCommand(
  options: InstallBrowsersOptions,
  io: CommandIo,
): Promise<number> {
  const names: BrowserName[] = ["chromium"];
  if (options.firefox || options.all) names.push("firefox");
  if (options.webkit || options.all) names.push("webkit");
  const { installBrowsers } = await import("@testament/browser");
  return installBrowsers(names, { withDeps: options.withDeps ?? false, stdout: io.stdout });
}

export function registerBrowserCommands(program: Command, io: () => CommandIo): void {
  program
    .command("install-browsers")
    .description("download the browsers tests run in (Chromium; add --firefox, --webkit or --all)")
    .option("--firefox", "also install Firefox")
    .option("--webkit", "also install WebKit (the Safari engine)")
    .option("--all", "install Chromium, Firefox and WebKit")
    .option("--with-deps", "also install system libraries (Linux, needs sudo)")
    .action(async (options: InstallBrowsersOptions) => {
      process.exitCode = await runInstallBrowsersCommand(options, io());
    });

  program
    .command("snapshot")
    .description("debug: print what the agent sees on a page, and any refused requests")
    .argument("<url>", "page to open (relative URLs use the environment's baseUrl)")
    .option("-e, --env <name>", "environment whose baseUrl and allowed domains apply")
    .option("--device <preset>", "device preset, e.g. desktop, laptop, ipad, iphone-15, pixel-8")
    .option("--browser <name>", "chromium (default), firefox or webkit")
    .option("--screenshot <file>", "also save a PNG screenshot")
    .option(
      "--storage-state <file>",
      "start with these cookies and local storage (Playwright storage state JSON)",
    )
    .option("-C, --dir <path>", "project folder (default: nearest folder with the project file)")
    .option("--json", "print machine-readable JSON")
    .action(async (url: string, options: SnapshotCommandOptions) => {
      process.exitCode = await runSnapshotCommand(url, options, io());
    });
}
