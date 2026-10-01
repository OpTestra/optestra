import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";
import { ENV_PREFIX } from "@optestra/config";
import { startShop, type Variant } from "@optestra/fixture-shop";
import { branchDir, promoteBranch } from "@optestra/recording/node";
import { applyHeals } from "../src/heal/review.js";
import { afterAll, describe, expect, it } from "vitest";
import { runTests } from "../src/run/runner.js";

// Branch-aware recordings (REP-8) on the real shop. The project is a GitHub
// checkout (a .git folder with a github.com remote) on a feature branch:
// - the run replays the branch's recording, not main's (main's is out of date
//   here: its locator no longer exists, so main's replay needs a heal);
// - what it writes (here an accepted fix) goes to the branch's folder, never over main's;
// - after `recordings promote` main's runs replay the promoted recording.

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const BRANCH = "feature/discounts";
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const OPEN = `---
name: The settings page opens
start: /dashboard
auth: ada
setup:
  - request: POST /__test/seed
---

1. Go to the settings page
`;

function checkout(branch: string, dir: string): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  writeFileSync(
    join(dir, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:acme/shop.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
  );
}

function project(): { dir: string; data: string; tests: string } {
  const dir = mkdtempSync(join(tmpdir(), "branches-e2e-"));
  dirs.push(dir);
  cpSync(join(SHOP, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(SHOP, "tests"), join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests/settings-open.test.md"), OPEN);
  const data = join(dir, "tests", brand.dataDirName);
  const profile = JSON.parse(
    readFileSync(join(data, "tests__settings-profile.steps.json"), "utf8"),
  ) as { steps: Array<{ commands: Array<Record<string, unknown>> }> };
  const good = {
    ...profile,
    testId: "tests__settings-open",
    testPath: "tests/settings-open.test.md",
    steps: profile.steps.slice(0, 1),
    checks: [],
  };
  // Main's recording: a link the app no longer has (and no fallback locators).
  const stale = structuredClone(good);
  const command = stale.steps[0]?.commands[0] as {
    action: { target: { name: string } };
    fingerprint: { primary: { name: string }; fallbacks: unknown[]; name: string };
  };
  command.action.target.name = "Preferences";
  command.fingerprint.primary.name = "Preferences";
  command.fingerprint.name = "Preferences";
  command.fingerprint.fallbacks = [];
  writeFileSync(join(data, "tests__settings-open.steps.json"), JSON.stringify(stale, null, 2));
  const own = branchDir(join(dir, "tests"), BRANCH);
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "tests__settings-open.steps.json"), JSON.stringify(good, null, 2));
  checkout(BRANCH, dir);
  return { dir, data, tests: join(dir, "tests") };
}

async function run(dir: string, test: string, variant: Variant = "correct") {
  const shop = await startShop({ variant, port: 0 });
  try {
    return await runTests({
      projectDir: dir,
      tests: [join(dir, "tests", test)],
      mode: "normal",
      models: null,
      retries: 0,
      video: false,
      generateSpecs: false,
      evidence: "failures",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        [`${ENV_PREFIX}BASE_URL`]: shop.url,
        SHOP_PASSWORD: "shop-demo-pass",
      },
    });
  } finally {
    await shop.stop();
  }
}

describe("branch recordings on the shop", () => {
  it("a branch's recording is used, what it records stays on the branch, and promote moves it into place", async () => {
    const { dir, data, tests } = project();
    const own = branchDir(tests, BRANCH);

    // On the feature branch: its own recording replays.
    const onBranch = await run(dir, "settings-open.test.md");
    expect(onBranch.tests[0]?.verdict, onBranch.tests[0]?.headline ?? "").toBe("passed");
    expect(onBranch.run.git?.branch).toBe(BRANCH);

    // The cosmetic build reworded two buttons: healed without AI, and the
    // fix accepted. It goes to a new branch recording; main's stays as it was.
    const main = readFileSync(join(data, "tests__avatar-upload.steps.json"), "utf8");
    const healed = await run(dir, "avatar-upload.test.md", "cosmetic");
    expect(healed.tests[0]?.verdict, healed.tests[0]?.headline ?? "").toBe("healed");
    const applied = await applyHeals(dir, healed.dir, "all", { env: {}, generateSpecs: false });
    expect(applied.recordings).toEqual([
      `tests/${brand.dataDirName}/branches/feature--discounts/tests__avatar-upload.steps.json`,
    ]);
    expect(existsSync(join(own, "tests__avatar-upload.steps.json"))).toBe(true);
    expect(readFileSync(join(data, "tests__avatar-upload.steps.json"), "utf8")).toBe(main);
    // The branch's run replays its fixed recording: no heal this time.
    const again = await run(dir, "avatar-upload.test.md", "cosmetic");
    expect(again.tests[0]?.verdict, again.tests[0]?.headline ?? "").toBe("passed");

    // On main, before the promote: main's (stale) recording, untouched.
    checkout("main", dir);
    const onMain = await run(dir, "settings-open.test.md");
    // Its stale link is only re-found from the fingerprint (a heal); the branch's needed none.
    expect(onMain.tests[0]?.verdict).toBe("healed");

    // After the merge: promote, and main replays the branch's recordings.
    const moved = promoteBranch(tests, BRANCH);
    expect(moved.map((m) => [m.testId, m.replaced])).toEqual([
      ["tests__avatar-upload", true],
      ["tests__settings-open", true],
    ]);
    expect(existsSync(own)).toBe(false);
    const promoted = await run(dir, "settings-open.test.md");
    expect(promoted.tests[0]?.verdict, promoted.tests[0]?.headline ?? "").toBe("passed");
    // The promoted avatar-upload has the accepted fix: the cosmetic build replays it as is.
    const fixed = await run(dir, "avatar-upload.test.md", "cosmetic");
    expect(fixed.tests[0]?.verdict, fixed.tests[0]?.headline ?? "").toBe("passed");
  });
});
