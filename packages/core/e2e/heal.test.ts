import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { ENV_PREFIX } from "@testament/config";
import { runLayout } from "@testament/contract";
import { readHealReview } from "@testament/contract/node";
import { startShop, type Variant } from "@testament/fixture-shop";
import { afterAll, describe, expect, it } from "vitest";
import { agentScript, scriptedModels } from "../src/author/test-kit.test-support.js";
import { applyHeals, listHeals } from "../src/heal/review.js";
import { type RunTestsOptions, runTests } from "../src/run/runner.js";

// HEAL-0 on the real shop, in a real browser, with a scripted fixer model:
// the cosmetic build under review / auto / strict, accept and reject, the
// next run with zero AI, the repeated-heal flag, and bugs that stay red.

const SHOP = fileURLToPath(new URL("../../../bench/fixtures/shop/", import.meta.url));
const PASSWORD = "shop-demo-pass";
const projects: string[] = [];

afterAll(() => {
  for (const dir of projects) rmSync(dir, { recursive: true, force: true });
});

function project(policy?: "strict" | "review" | "auto"): string {
  const dir = mkdtempSync(join(tmpdir(), "heal-e2e-"));
  projects.push(dir);
  cpSync(join(SHOP, brand.configFileName), join(dir, brand.configFileName));
  cpSync(join(SHOP, "tests"), join(dir, "tests"), {
    recursive: true,
    filter: (source) => !/\.ts$/.test(source) && !source.includes(`${brand.dataDirName}/authoring`),
  });
  if (policy) appendFileSync(join(dir, brand.configFileName), `\nrun:\n  healPolicy: ${policy}\n`);
  return dir;
}

/** The fixer's answer for the cosmetic build's reworded buttons. */
const fixer = () =>
  agentScript([
    [/Click "Create"$/, [{ name: "click", on: { role: "button", name: "Save project" } }]],
    [/Click "Save changes"$/, [{ name: "click", on: { role: "button", name: "Save profile" } }]],
  ]);

async function run(
  dir: string,
  variant: Variant,
  tests: string[],
  options: Partial<RunTestsOptions> & { script?: ReturnType<typeof fixer> } = {},
) {
  const shop = await startShop({ variant, port: 0 });
  const { models, calls } = scriptedModels(
    options.script ?? (() => ({ text: "no model should be asked" })),
  );
  try {
    const result = await runTests({
      projectDir: dir,
      tests: tests.map((t) => join(dir, "tests", `${t}.test.md`)),
      mode: "normal",
      retries: 0,
      video: false,
      generateSpecs: false,
      models,
      beforeAttempt: async ({ attempt, session }) => {
        await session.hookRequest({
          method: "POST",
          target: attempt === 1 ? "/__test/reset?environment=1" : "/__test/reset",
        });
      },
      ...options,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        [`${ENV_PREFIX}BASE_URL`]: shop.url,
        SHOP_PASSWORD: PASSWORD,
      },
    });
    const byFile = (name: string) => {
      const test = result.tests.find((t) => t.file === `tests/${name}.test.md`);
      if (!test) throw new Error(`no result for ${name}`);
      return test;
    };
    return { result, calls, byFile };
  } finally {
    await shop.stop();
  }
}

const recordingText = (dir: string, name: string) =>
  readFileSync(join(dir, "tests", brand.dataDirName, `tests__${name}.steps.json`), "utf8");

describe("heals on the cosmetic shop (scripted fixer)", () => {
  it("review: the fixer heals the reworded buttons, nothing changes until accepted; after accept the re-run uses zero AI", async () => {
    const dir = project();
    const before = recordingText(dir, "create-project");
    const first = await run(dir, "cosmetic", ["create-project", "settings-profile"], {
      script: fixer(),
    });
    expect(first.byFile("create-project").verdict).toBe("healed");
    expect(first.calls.length).toBeGreaterThan(0);
    // Guarantee 1 on a real app: the fixer redoes "Save changes" as "Save profile", but the
    // cosmetic build also renamed the "Full name" field, so the check on it fails, as it must.
    const profile = first.byFile("settings-profile");
    const steps = profile.attempts.at(-1)?.steps ?? [];
    expect(steps.find((s) => s.text === 'Click "Save changes"')).toMatchObject({
      status: "passed",
      recovery: "fixer",
    });
    expect(profile.verdict).toBe("failed");
    expect(profile.decidedBy[0]?.kind).toBe("check");
    expect(profile.headline).toMatch(/"Full name" contains "Ada King"/);
    const create = first.byFile("create-project");
    const heals = create.attempts.at(-1)?.heals ?? [];
    expect(heals.some((h) => h.level === "fixer")).toBe(true);
    expect(heals.every((h) => h.status === "pending")).toBe(true);
    expect(create.attempts.at(-1)?.modelCalls.every((c) => c.role === "fixer")).toBe(true);
    // Nothing is fixed silently: the recording is unchanged, the patches are in the run.
    expect(recordingText(dir, "create-project")).toBe(before);
    for (const heal of heals)
      expect(
        existsSync(join(first.result.dir, runLayout.healPatch(create.testId, 1, heal.id))),
      ).toBe(true);

    const listing = listHeals(first.result.dir);
    expect(listing.heals.length).toBe(
      first.result.tests.reduce((n, t) => n + (t.attempts.at(-1)?.heals.length ?? 0), 0),
    );
    const fixed = listing.heals.find((h) => h.level === "fixer" && h.file.includes("create"));
    expect(fixed?.before).toEqual(["click the button 'Create'"]);
    expect(fixed?.after).toEqual(["click the button 'Save project'"]);
    expect(fixed?.why[0]).toMatch(/fixer model/);
    expect(fixed?.acceptable).toBe(true);

    // The failed test's heals never proved themselves: `all` takes only the healed test's.
    expect(
      listing.heals.filter((h) => h.file.includes("settings")).every((h) => !h.acceptable),
    ).toBe(true);
    const accepted = await applyHeals(dir, first.result.dir, "all", { generateSpecs: false });
    expect(accepted.skipped).toEqual([]);
    expect(accepted.accepted.map((h) => h.id).sort()).toEqual(heals.map((h) => h.id).sort());
    expect(accepted.recordings).toEqual([
      `tests/${brand.dataDirName}/tests__create-project.steps.json`,
    ]);
    expect(accepted.labels).toBeGreaterThan(0);
    const labels = readdirSync(join(dir, brand.dataDirName, "labels"));
    expect(labels).toEqual(
      expect.arrayContaining(["same_element.jsonl", "miss_action.jsonl", "heal_class.jsonl"]),
    );
    // Only the healed steps changed: every check is exactly as it was.
    const after = JSON.parse(recordingText(dir, "create-project"));
    expect(after.checks).toEqual(JSON.parse(before).checks);
    // The decision is in the run folder; the listing shows it.
    expect(readHealReview(first.result.dir)?.decisions.every((d) => d.status === "accepted")).toBe(
      true,
    );
    expect(
      listHeals(first.result.dir)
        .heals.filter((h) => h.file.includes("create"))
        .every((h) => h.status === "accepted" && h.appliedBy === "human"),
    ).toBe(true);

    // Paid once (LRN-3): the next run replays the accepted steps with no AI at all.
    const second = await run(dir, "cosmetic", ["create-project"]);
    expect(second.calls).toHaveLength(0);
    expect(second.byFile("create-project").verdict).toBe("passed");
  });

  it("reject leaves the recording alone and records the decision", async () => {
    const dir = project();
    const before = recordingText(dir, "create-project");
    const first = await run(dir, "cosmetic", ["create-project"], { script: fixer() });
    const ids = listHeals(first.result.dir).heals.map((h) => h.id);
    const rejected = await applyHeals(dir, first.result.dir, [], { reject: ids });
    expect(rejected.rejected.map((h) => h.id).sort()).toEqual([...ids].sort());
    expect(rejected.accepted).toEqual([]);
    expect(recordingText(dir, "create-project")).toBe(before);
    expect(listHeals(first.result.dir).heals.every((h) => h.status === "rejected")).toBe(true);
  });

  it("auto: heals are applied at once as accepted proposals, except behaviour changes", async () => {
    const dir = project("auto");
    const first = await run(dir, "cosmetic", ["create-project"], { script: fixer() });
    const create = first.byFile("create-project");
    expect(create.verdict).toBe("healed");
    const heals = create.attempts.at(-1)?.heals ?? [];
    expect(heals.length).toBeGreaterThan(0);
    for (const heal of heals)
      expect(heal).toMatchObject(
        heal.classification === "behavior_change"
          ? { status: "pending", policy: "auto" }
          : { status: "accepted", appliedBy: "auto", policy: "auto" },
      );
    expect(heals.some((h) => h.status === "accepted")).toBe(true);
    expect(first.result.recorded.map((r) => r.test)).toEqual(["tests/create-project.test.md"]);
    const events = readFileSync(join(first.result.dir, "events.ndjson"), "utf8");
    if (heals.some((h) => h.classification === "behavior_change"))
      expect(events).toMatch(
        /Not applied \(heal policy auto\): the app's behaviour may have changed/,
      );
    // The applied steps now replay from the recording; only a pending one would need a heal again.
    const second = await run(dir, "cosmetic", ["create-project"], { script: fixer() });
    const steps = second.byFile("create-project").attempts.at(-1)?.steps ?? [];
    for (const heal of heals.filter((h) => h.status === "accepted"))
      expect(steps.find((s) => s.index === heal.stepIndex)?.recovery).toBe("replay");
  });

  it("strict never heals: the cosmetic build fails on its first miss, with no AI", async () => {
    const dir = project("strict");
    const { byFile, calls } = await run(dir, "cosmetic", ["login"], { script: fixer() });
    expect(calls).toHaveLength(0);
    const login = byFile("login");
    expect(login.verdict).toBe("failed");
    expect(login.attempts.every((a) => a.heals.length === 0)).toBe(true);
    expect(login.headline).toMatch(/heal policy strict/);
  });

  it("flags a test that healed 3 times in its last 10 runs: re-record it (HEAL-7)", async () => {
    const dir = project();
    let last: Awaited<ReturnType<typeof run>> | undefined;
    for (let i = 0; i < 3; i++) last = await run(dir, "cosmetic", ["login"]);
    const login = last?.byFile("login");
    expect(login?.verdict).toBe("healed");
    expect(login?.recentHeals).toEqual({ runs: 3, healed: 3 });
    const listing = listHeals(last?.result.dir as string);
    expect(listing.rerecord).toEqual([
      expect.objectContaining({
        file: "tests/login.test.md",
        healed: 3,
        command: `${brand.cliName} run tests/login.test.md --rerecord`,
      }),
    ]);
    const events = readFileSync(join(last?.result.dir as string, "events.ndjson"), "utf8");
    expect(events).toMatch(/re-record this test/);
  });

  it("no heal turns a real bug green: broken-silent-click still fails, and the fixer is never asked", async () => {
    const dir = project();
    const { byFile, calls } = await run(dir, "broken-silent-click", ["create-project"], {
      script: fixer(),
    });
    expect(calls).toHaveLength(0);
    const test = byFile("create-project");
    expect(test.verdict).toBe("failed");
    expect(test.attempts.every((a) => a.heals.length === 0)).toBe(true);
  });
});
