import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { brand } from "@testament/brand";
import { ENV_PREFIX } from "@testament/config";
import { startShop, type Variant } from "@testament/fixture-shop";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeProject } from "../src/fixture-project.test-support.js";
import { generateProject } from "../src/node/index.js";

// Promise 2, for real: the generated specs run with plain `playwright test`
// against the demo shop, from a project whose node_modules holds only
// @playwright/test. Chromium only here; the generated config also has Firefox
// and WebKit projects.

const here = fileURLToPath(new URL("..", import.meta.url));
const PASSWORD = "shop-demo-pass";
let project: string;
let mailpit: Server;
let mailpitUrl = "";
let shopUrl = "";

/** A stand-in for Mailpit's HTTP API, backed by the shop's outbox (the shop only speaks SMTP). */
function startMailpit(): Promise<void> {
  mailpit = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mailpit.invalid");
    const outbox = async (to: string) => {
      const response = await fetch(`${shopUrl}/__test/outbox?to=${encodeURIComponent(to)}`);
      return ((await response.json()) as { emails: Array<{ text: string }> }).emails;
    };
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/search") {
      const to = /to:"([^"]+)"/.exec(url.searchParams.get("query") ?? "")?.[1] ?? "";
      const emails = await outbox(to);
      const messages = emails.length ? [{ ID: `${emails.length - 1}:${to}` }] : [];
      res.end(JSON.stringify({ messages }));
      return;
    }
    const id = /^\/api\/v1\/message\/(\d+):(.+)$/.exec(decodeURIComponent(url.pathname));
    if (id) {
      const emails = await outbox(id[2] as string);
      res.end(JSON.stringify({ Text: emails[Number(id[1])]?.text ?? "" }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) =>
    mailpit.listen(0, "127.0.0.1", () => {
      mailpitUrl = `http://127.0.0.1:${(mailpit.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

beforeAll(async () => {
  project = composeProject();
  const result = await generateProject({ projectDir: project, env: {} });
  expect(result.ok).toBe(true);
  // Only @playwright/test: no workspace packages, no package.json.
  mkdirSync(join(project, "node_modules", "@playwright"), { recursive: true });
  symlinkSync(
    realpathSync(join(here, "node_modules", "@playwright", "test")),
    join(project, "node_modules", "@playwright", "test"),
    "junction",
  );
  await startMailpit();
});

afterAll(async () => {
  await new Promise((resolve) => mailpit?.close(resolve));
  rmSync(project, { recursive: true, force: true });
});

interface Outcome {
  status: string;
  /** Title of the innermost step that failed. */
  step?: string;
  error?: string;
}

interface ReportStep {
  title: string;
  error?: { message?: string };
  steps?: ReportStep[];
}
interface ReportSuite {
  specs?: Array<{
    title: string;
    tests: Array<{
      results: Array<{ status: string; steps?: ReportStep[]; error?: { message?: string } }>;
    }>;
  }>;
  suites?: ReportSuite[];
}

function failedStep(steps: ReportStep[] | undefined): string | undefined {
  for (const step of steps ?? []) {
    if (!step.error) continue;
    return failedStep(step.steps) ?? step.title;
  }
  return undefined;
}

function runNode(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", () => resolve({ stdout, stderr }));
  });
}

/** Runs `playwright test -c <tests>/<data dir>` in the project with plain Playwright. */
async function runSpecs(
  variant: Variant,
  options: {
    env?: Record<string, string>;
    dir?: string;
    grep?: string;
    /** Keep the config's reporters (list + the trace scrubber) instead of `--reporter=json`. */
    configReporters?: boolean;
  } = {},
): Promise<Record<string, Outcome>> {
  const shop = await startShop({ variant, port: 0 });
  shopUrl = shop.url;
  const dir = options.dir ?? project;
  const report = join(dir, `report-${variant}-${Date.now()}.json`);
  try {
    const cli = join(dir, "node_modules", "@playwright", "test", "cli.js");
    // Async: the shop and the Mailpit stand-in are served from this process.
    const run = await runNode(
      process.execPath,
      [
        cli,
        "test",
        "-c",
        `tests/${brand.dataDirName}`,
        "--project=chromium",
        "--workers=1",
        "--retries=0",
        ...(options.configReporters ? [] : ["--reporter=json"]),
        ...(options.grep ? ["--grep", options.grep] : []),
      ],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...(process.env.PLAYWRIGHT_BROWSERS_PATH
            ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
            : {}),
          PLAYWRIGHT_JSON_OUTPUT_NAME: report,
          [`${ENV_PREFIX}BASE_URL`]: shop.url,
          [`${ENV_PREFIX}MAILPIT_URL`]: mailpitUrl,
          SHOP_PASSWORD: PASSWORD,
          ...options.env,
        },
      },
    );
    if (options.configReporters) return {};
    let json: { suites: ReportSuite[] };
    try {
      json = JSON.parse(readFileSync(report, "utf8"));
    } catch {
      throw new Error(`no report from playwright:\n${run.stdout}\n${run.stderr}`);
    }
    const out: Record<string, Outcome> = {};
    const walk = (suite: ReportSuite) => {
      for (const spec of suite.specs ?? []) {
        const result = spec.tests[0]?.results.at(-1);
        const step = failedStep(result?.steps);
        out[spec.title] = {
          status: result?.status ?? "none",
          ...(step ? { step } : {}),
          ...(result?.error?.message ? { error: result.error.message } : {}),
        };
      }
      for (const child of suite.suites ?? []) walk(child);
    };
    for (const suite of json.suites) walk(suite);
    return out;
  } finally {
    await shop.stop();
  }
}

const passed = { status: "passed" };
const ALL = [
  "A new project is saved",
  "A trial costs nothing today",
  "A user can upload an avatar",
  "New customer can start a Pro trial",
  "Orders can be sorted by total",
  "Pages only reach allowed hosts",
  "Profile changes are saved",
  "Settings can be changed without going near account deletion",
];
const expected = (overrides: Record<string, Partial<Outcome>>) =>
  Object.fromEntries(ALL.map((title) => [title, overrides[title] ?? passed]));
const summary = (outcomes: Record<string, Outcome>) =>
  Object.fromEntries(
    Object.entries(outcomes).map(([title, o]) => [
      title,
      o.step ? { status: o.status, step: o.step } : { status: o.status },
    ]),
  );

/** Entries of a zip, read independently of the generated reporter's own reader. */
function unzip(file: string): Map<string, Buffer> {
  const zip = readFileSync(file);
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  const entries = new Map<string, Buffer>();
  let offset = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0; n--) {
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    entries.set(name, method === 8 ? inflateRawSync(raw) : raw);
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return entries;
}

function keptTraces(dir: string): string[] {
  // Playwright's default output folder, under the folder it runs in.
  const results = join(dir, "test-results");
  if (!existsSync(results)) return [];
  return readdirSync(results, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".zip"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Every way the secret could still be in a trace: as typed, escaped, URL-encoded or in base64. */
function findSecret(entries: Map<string, Buffer>, secret: string): string[] {
  const forms = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
  const found: string[] = [];
  for (const [name, data] of entries) {
    const text = data.toString("latin1");
    for (const form of forms) if (text.includes(form)) found.push(`${name}: ${form}`);
    for (const [run] of text.matchAll(/[A-Za-z0-9+/_-]{12,}={0,2}/g)) {
      const decoded = Buffer.from(run, /[-_]/.test(run) ? "base64url" : "base64").toString(
        "latin1",
      );
      if (forms.some((form) => decoded.includes(form))) found.push(`${name}: base64 ${run}`);
    }
  }
  return found;
}

describe("generated specs with plain Playwright", () => {
  it("correct: every spec passes", async () => {
    expect(summary(await runSpecs("correct"))).toEqual(expected({}));
  });

  it("broken-total: the billing assertion fails, at that step", async () => {
    const step = { status: "failed", step: 'Expect: the page shows "$0.00 due today"' };
    expect(summary(await runSpecs("broken-total"))).toEqual(
      expected({ "A trial costs nothing today": step, "New customer can start a Pro trial": step }),
    );
  });

  it("broken-silent-click: create-project fails where the dialog should be open", async () => {
    expect(summary(await runSpecs("broken-silent-click"))).toEqual(
      expected({
        "A new project is saved": {
          status: "failed",
          step: 'Expect: a dialog titled "New project" is open',
        },
      }),
    );
  });

  it("the allowlist fixture is what aborts the request to a second host", async () => {
    // With localhost allowed, the navigation to it goes through and the code step fails.
    const open = await runSpecs("correct", {
      grep: "allowed hosts",
      env: { [`${ENV_PREFIX}ALLOWED_DOMAINS`]: "127.0.0.1,localhost" },
    });
    expect(summary(open)).toEqual({
      "Pages only reach allowed hosts": {
        status: "failed",
        step: "Opening a page on another host is refused",
      },
    });
  });

  it("a secret is refused on a host outside its domains", async () => {
    const dir = `${project}-secret-domains`;
    cpSync(project, dir, { recursive: true, verbatimSymlinks: true });
    const fixtures = join(dir, "tests", brand.dataDirName, `${brand.cliName}.fixtures.ts`);
    writeFileSync(
      fixtures,
      readFileSync(fixtures, "utf8").replace(
        'secrets: { SHOP_PASSWORD: ["127.0.0.1"] }',
        'secrets: { SHOP_PASSWORD: ["example.com"] }',
      ),
    );
    try {
      const outcome = (await runSpecs("correct", { dir, grep: "new project" }))[
        "A new project is saved"
      ];
      expect(outcome?.status).toBe("failed");
      expect(outcome?.step).toBe('Fill "Password" with {{params.password}}');
      expect(outcome?.error).toContain("Secret SHOP_PASSWORD may not be typed into 127.0.0.1");
      expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const via of ["the reporter", "the global teardown (another reporter in use)"]) {
    it(`a failed test's kept trace has the typed secret scrubbed out, via ${via}`, async () => {
      const dir = `${project}-trace-${via.startsWith("the reporter") ? "reporter" : "backstop"}`;
      cpSync(project, dir, { recursive: true, verbatimSymlinks: true });
      try {
        // Fails at step 3, after the login flow typed the password and posted the form.
        await runSpecs("broken-silent-click", {
          dir,
          grep: "new project",
          configReporters: via.startsWith("the reporter"),
        });
        const traces = keptTraces(dir);
        expect(traces.length).toBeGreaterThan(0);
        for (const trace of traces) {
          const entries = unzip(trace);
          expect([...entries.keys()]).toContain("test.trace");
          expect(findSecret(entries, PASSWORD)).toEqual([]);
          const text = [...entries.values()].map((data) => data.toString("latin1")).join("");
          // Scrubbed, not deleted: the placeholders are there.
          expect(text).toContain("[secret:SHOP_PASSWORD]");
          // The field was masked in the page (seen in the DOM snapshots).
          const snapshots = [...entries]
            .filter(([name]) => /-trace\.trace$/.test(name))
            .map(([, data]) => data.toString("utf8"))
            .join("");
          expect(snapshots).toContain(`data-${brand.cliName}-secret`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
