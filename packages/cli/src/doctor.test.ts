import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { ENV_PREFIX } from "@testament/config";
import { loadProject } from "@testament/config/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DoctorBrowser,
  type DoctorCheck,
  type DoctorProbes,
  type DoctorReport,
  runDoctor,
} from "./commands/doctor.js";
import { runGenerateCommand } from "./commands/generate.js";
import { SHOP_PASSWORD, shopProject } from "./shop-project.test-support.js";

// `doctor` (ONB-4) on the shop project: healthy, then with each problem planted,
// checking the exact fix each time. The browser is a stand-in here (a real one
// runs in e2e/); models go to a local OpenAI-compatible stand-in, so no test
// needs a key, a subscription tool or the internet.

const bin = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
let models: Server;
let modelsUrl = "";
const dirs: string[] = [];

beforeAll(async () => {
  models = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.url?.startsWith("/v1/models") ? '{"object":"list","data":[]}' : "{}");
  });
  await new Promise<void>((resolve) => models.listen(0, "127.0.0.1", resolve));
  modelsUrl = `http://127.0.0.1:${(models.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  await new Promise((resolve) => models.close(resolve));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The shop, with models on the local stand-in and specs generated. */
async function project(): Promise<string> {
  const dir = shopProject("cli-doctor-");
  dirs.push(dir);
  appendFileSync(
    join(dir, brand.configFileName),
    `\nmodels:\n  providers:\n    local:\n      kind: openai-compatible\n      baseUrl: ${modelsUrl}\n  roles:\n    planner:\n      - { provider: local, model: test-model }\n    fixer:\n      - { provider: local, model: test-model }\n`,
  );
  const code = await runGenerateCommand([], { dir }, { cwd: dir, env: {}, stdout: () => {} });
  expect(code).toBe(0);
  return dir;
}

const healthyEnv = { SHOP_PASSWORD, [`${ENV_PREFIX}INBOX_PROVIDER`]: "none" };

function fakeBrowser(
  answer: Awaited<ReturnType<DoctorBrowser["request"]>> = { status: "ok", httpStatus: 200 },
): DoctorProbes & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    openBrowser: async () => ({
      request: async (baseUrl) => {
        requests.push(baseUrl);
        return answer;
      },
      close: async () => {},
    }),
  };
}

const check = (report: DoctorReport, id: string) =>
  report.checks.find((c) => c.id === id) as DoctorCheck;
const failed = (report: DoctorReport) =>
  report.checks.filter((c) => c.status === "fail").map((c) => c.id);

describe("doctor", () => {
  it("a healthy shop: everything ok (unrecorded tests are a warning), exit 0", async () => {
    const dir = await project();
    const probes = fakeBrowser();
    const report = await runDoctor({ dir, env: healthyEnv, probes });
    expect(failed(report)).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(probes.requests).toEqual(["http://127.0.0.1:4100"]);
    expect(report.checks.map((c) => `${c.id} ${c.status}`)).toEqual([
      "node ok",
      "project ok",
      "tests ok",
      "browsers ok",
      "base-url:local ok",
      "secrets ok",
      "models ok",
      "provider:local ok",
      "decisions ok",
      "inbox skip",
      "recordings warn",
      "specs ok",
    ]);
    expect(check(report, "models").message).toBe(
      "planner → local / test-model, fixer → local / test-model",
    );
    expect(check(report, "recordings").fix).toBe(
      `Record each one: \`${brand.cliName} author tests/declined-card.test.md\` (and the others below).`,
    );
    // Warnings count with --strict.
    expect((await runDoctor({ dir, env: healthyEnv, probes, strict: true })).exitCode).toBe(1);
  });

  it("changes nothing on disk", async () => {
    const dir = await project();
    const before = readFileSync(join(dir, brand.configFileName), "utf8");
    await runDoctor({ dir, env: {}, probes: fakeBrowser() });
    expect(readFileSync(join(dir, brand.configFileName), "utf8")).toBe(before);
  });

  it("missing secret: names it (never a value) and says where to set it", async () => {
    const dir = await project();
    const report = await runDoctor({
      dir,
      env: { [`${ENV_PREFIX}INBOX_PROVIDER`]: "none" },
      probes: fakeBrowser(),
    });
    expect(failed(report)).toEqual(["secrets"]);
    expect(report.exitCode).toBe(2);
    const secrets = check(report, "secrets");
    expect(secrets.message).toBe(
      "0 of 1 declared secret value set (names only; values are never shown).",
    );
    const fix =
      "Add SHOP_PASSWORD=<value> to .env.local, or set the SHOP_PASSWORD environment variable.";
    expect(secrets.fix).toBe(fix);
    expect(secrets.details).toEqual([`local: SHOP_PASSWORD is not set. Fix: ${fix}`]);
  });

  it("bad base URL: can't be reached, fix names the setting", async () => {
    const dir = await project();
    const report = await runDoctor({
      dir,
      env: healthyEnv,
      probes: fakeBrowser({ status: "error", message: "connect ECONNREFUSED 127.0.0.1:4100" }),
    });
    expect(failed(report)).toEqual(["base-url:local"]);
    expect(check(report, "base-url:local")).toEqual({
      id: "base-url:local",
      title: "Base URL (local)",
      status: "fail",
      message: "http://127.0.0.1:4100 can't be reached: connect ECONNREFUSED 127.0.0.1:4100",
      fix: `Start your app so it answers at http://127.0.0.1:4100, or change environments.local.baseUrl in ${brand.configFileName}.`,
    });
  });

  it("no browsers: Chromium can't start, fix is install-browsers; base URLs are skipped", async () => {
    const dir = await project();
    const report = await runDoctor({
      dir,
      env: healthyEnv,
      probes: {
        openBrowser: async () => ({
          error: "Could not start chromium: Executable doesn't exist at /x/chrome",
          fix: `Run \`${brand.cliName} install-browsers\`.`,
        }),
      },
    });
    expect(failed(report)).toEqual(["browsers"]);
    expect(check(report, "browsers").fix).toBe(`Run \`${brand.cliName} install-browsers\`.`);
    expect(check(report, "base-url:local").status).toBe("skip");
  });

  it("no browsers, for real: the harness reports the missing executable", async () => {
    const dir = await project();
    const empty = mkdtempSync(join(tmpdir(), "cli-doctor-browsers-"));
    dirs.push(empty);
    // Async: the models stand-in is served from this process.
    const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>(
      (resolve) => {
        const child = spawn(process.execPath, [bin, "doctor", "--json"], {
          cwd: dir,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            PLAYWRIGHT_BROWSERS_PATH: empty,
            ...healthyEnv,
          },
        });
        let out = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
        });
        child.on("close", (exit) => resolve({ code: exit, stdout: out }));
      },
    );
    expect(code).toBe(2);
    const report = JSON.parse(stdout) as DoctorReport;
    expect(check(report, "browsers")).toMatchObject({
      status: "fail",
      fix: `Run \`${brand.cliName} install-browsers\`.`,
    });
    expect(stdout).not.toContain(SHOP_PASSWORD);
  });

  it("invalid config: fails with the config diagnostic's own fix and line", async () => {
    const dir = await project();
    appendFileSync(join(dir, brand.configFileName), "run:\n  retries: -1\n");
    const expected = loadProject(dir, { env: {} }).diagnostics.find((d) => d.severity === "error");
    expect(expected?.code).toBe("INVALID_VALUE");
    const report = await runDoctor({ dir, env: healthyEnv, probes: fakeBrowser() });
    expect(failed(report)).toEqual(["project"]);
    expect(check(report, "project")).toMatchObject({
      status: "fail",
      message: `${brand.configFileName} has 1 error.`,
      fix: expected?.fix,
      details: [
        `INVALID_VALUE (line ${expected?.line}): ${expected?.message} Fix: ${expected?.fix}`,
      ],
    });
  });

  it("no project: says to run init", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-doctor-none-"));
    dirs.push(dir);
    const report = await runDoctor({ dir, env: {}, probes: fakeBrowser() });
    expect(report.project).toBeNull();
    expect(check(report, "project").fix).toBe(
      `Run \`${brand.cliName} init\` in your repository, or run this inside a project folder.`,
    );
    expect(report.exitCode).toBe(2);
  });

  it("stale spec: the test changed since generate; fix is generate", async () => {
    const dir = await project();
    const test = join(dir, "tests", "sort-orders.test.md");
    writeFileSync(
      test,
      readFileSync(test, "utf8").replace("tags: [tables]", "tags: [tables, orders]"),
    );
    const report = await runDoctor({ dir, env: healthyEnv, probes: fakeBrowser() });
    expect(check(report, "specs")).toEqual({
      id: "specs",
      title: "Playwright specs",
      status: "warn",
      message: "1 generated file is out of date.",
      fix: `Run \`${brand.cliName} generate\`.`,
      details: [
        `tests/${brand.dataDirName}/tests__sort-orders.spec.ts: out of date. Fix: \`${brand.cliName} generate\``,
      ],
    });
  });

  it("--json: the report schema", async () => {
    const dir = await project();
    const report = JSON.parse(
      JSON.stringify(await runDoctor({ dir, env: healthyEnv, probes: fakeBrowser() })),
    );
    expect(Object.keys(report).sort()).toEqual(
      ["checks", "environments", "exitCode", "project", "schema", "summary"].sort(),
    );
    expect(report.schema).toBe(1);
    expect(report.environments).toEqual(["local"]);
    expect(Object.keys(report.summary).sort()).toEqual(["fail", "ok", "skip", "warn"]);
    for (const c of report.checks as DoctorCheck[]) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.title).toBe("string");
      expect(["ok", "warn", "fail", "skip"]).toContain(c.status);
      expect(typeof c.message).toBe("string");
      if (c.status === "warn" || c.status === "fail") expect(c.fix).toBeTruthy();
    }
  });
});
