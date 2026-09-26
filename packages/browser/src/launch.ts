import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type Browser, type BrowserType, chromium, firefox, webkit } from "playwright";
import { brand } from "@testament/brand";
import type { BrowserName } from "./types.js";

// One browser per worker, one context per test. A LaunchedBrowser never exposes
// the Playwright Browser: sessions reach it through `browserOf`, inside this package.

const ENGINES: Record<BrowserName, BrowserType> = { chromium, firefox, webkit };
const handles = new WeakMap<LaunchedBrowser, Browser>();

export interface LaunchOptions {
  browser?: BrowserName;
  /** Default true. */
  headless?: boolean;
}

export class BrowserSetupError extends Error {
  override name = "BrowserSetupError";
  constructor(
    message: string,
    /** What the user can do about it. */
    readonly fix: string,
  ) {
    super(message);
  }
}

export class LaunchedBrowser {
  readonly name: BrowserName;
  readonly version: string;

  private constructor(name: BrowserName, version: string) {
    this.name = name;
    this.version = version;
  }

  /** @internal */
  static wrap(name: BrowserName, browser: Browser): LaunchedBrowser {
    const launched = new LaunchedBrowser(name, browser.version());
    handles.set(launched, browser);
    return launched;
  }

  get connected(): boolean {
    return handles.get(this)?.isConnected() ?? false;
  }

  async close(): Promise<void> {
    await handles
      .get(this)
      ?.close()
      .catch(() => {});
  }
}

/** @internal The Playwright browser behind a handle. */
export function browserOf(launched: LaunchedBrowser): Browser {
  const browser = handles.get(launched);
  if (!browser) throw new BrowserSetupError("Not a launched browser.", "Use launchBrowser().");
  return browser;
}

/** Launches a browser. Throws BrowserSetupError (with a fix) when it isn't installed. */
export async function launchBrowser(options: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const name = options.browser ?? "chromium";
  const engine = ENGINES[name];
  if (!engine) {
    throw new BrowserSetupError(`Unknown browser "${name}".`, "Use chromium, firefox or webkit.");
  }
  try {
    const browser = await engine.launch({
      headless: options.headless ?? true,
      // No persistent profile: every launch starts from a fresh temporary one.
      args: name === "chromium" ? ["--disable-sync", "--no-first-run"] : [],
    });
    return LaunchedBrowser.wrap(name, browser);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    const missing = /Executable doesn't exist|install/i.test(String(error));
    throw new BrowserSetupError(
      `Could not start ${name}: ${message}`,
      missing
        ? `Run \`${brand.cliName} install-browsers${name === "chromium" ? "" : ` --${name}`}\`.`
        : "Check the browser installation.",
    );
  }
}

/** Runs Playwright's installer for the given engines. Resolves to its exit code. */
export function installBrowsers(
  names: readonly BrowserName[] = ["chromium"],
  options: { withDeps?: boolean; stdout?: (text: string) => void } = {},
): Promise<number> {
  const cli = join(
    dirname(createRequire(import.meta.url).resolve("playwright/package.json")),
    "cli.js",
  );
  const args = [cli, "install", ...(options.withDeps ? ["--with-deps"] : []), ...names];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const write = options.stdout ?? ((text: string) => process.stdout.write(text));
    child.stdout.on("data", (chunk: Buffer) => write(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => write(chunk.toString()));
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
