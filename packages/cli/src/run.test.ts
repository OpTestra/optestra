import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { runRunCommand } from "./commands/run.js";
import { createProgram } from "./program.js";
import { shopProject } from "./shop-project.test-support.js";

// `run`'s PERF-0 flags: a matrix (--browser / --device repeat), --locale,
// --timezone and --evidence, checked before anything starts.

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function runWith(options: Parameters<typeof runRunCommand>[1]) {
  const dir = shopProject("cli-run-");
  dirs.push(dir);
  let out = "";
  const code = await runRunCommand(
    [],
    { dir, ...options },
    {
      cwd: dir,
      env: {},
      stdout: (text) => {
        out += text;
      },
    },
  );
  return { code, out };
}

describe("run flags (PERF-0)", () => {
  it("refuses an unknown browser or evidence mode (exit 2) before running anything", async () => {
    const browser = await runWith({ browser: ["chromium", "opera"] });
    expect(browser.code).toBe(2);
    expect(browser.out).toBe('--browser must be chromium, firefox or webkit, not "opera".\n');
    const evidence = await runWith({ evidence: "everything" });
    expect(evidence.code).toBe(2);
    expect(evidence.out).toBe('--evidence must be full, failures or minimal, not "everything".\n');
  });

  it("refuses a viewport that isn't a size (exit 2)", async () => {
    const bad = await runWith({ viewport: "big" });
    expect(bad.code).toBe(2);
    expect(bad.out).toMatch(/^--viewport: The viewport "big" isn't a size like 1280x720/);
    const tiny = await runWith({ viewport: "50x50" });
    expect(tiny.code).toBe(2);
  });

  it("collects repeated --browser and --device into a matrix", () => {
    const run = createProgram().commands.find((c) => c.name() === "run");
    expect(run).toBeDefined();
    run?.parseOptions([
      "--browser",
      "chromium",
      "--browser",
      "webkit",
      "--device",
      "laptop",
      "--device",
      "iphone-15",
      "--locale",
      "de-DE",
      "--timezone",
      "Europe/Berlin",
      "--evidence",
      "minimal",
    ]);
    expect(run?.opts()).toMatchObject({
      browser: ["chromium", "webkit"],
      device: ["laptop", "iphone-15"],
      locale: "de-DE",
      timezone: "Europe/Berlin",
      evidence: "minimal",
    });
  });
});
