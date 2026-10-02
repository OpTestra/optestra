import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { brand } from "@optestra/brand";
import type { Config } from "@optestra/config";
import { loadProject, parseYaml } from "@optestra/config/node";
import type { ModelCall, TestResult } from "@optestra/contract";
import { BudgetMeter } from "@optestra/models";
import { checkTest, type Finding, lintProject, specSteps, type TestSpec } from "@optestra/spec";
import { nodeFileReader } from "@optestra/spec/node";
import { matchRules } from "../checks/rules.js";
import { draftTest } from "../draft/project.js";
import { version } from "../index.js";
import type { RunTestsResult } from "../run/runner.js";
import {
  add,
  androidRunner,
  type CallTotals,
  type FixtureRunner,
  none,
  shopRunner,
  totals,
} from "./comparison.js";
import { androidFixture, mailpitRunning, projectCopy, rowsOf, shopFixture } from "./fixtures.js";
import { fixtureMetrics, type Rate } from "./metrics.js";
import { entryId, type ModelEntry, modelsFor, withoutRecordings } from "./models.js";
import { engineCommit } from "./run.js";
import type { BenchRow, FixtureId } from "./score.js";

// COST-0: the real-developer corpus. Every entry re-phrases a gold test (same
// front matter, intent and expected verdict on every variant) in one of the
// phrasing styles of bench/corpus/styles.yaml, so false passes and false fails
// stay measurable against the fixture's manifest. Two routes in: the text as a
// test file (lint, then authoring), or as a description (`new` drafts a test,
// which is then authored). Per style: lint, how many Expect lines the phrase
// rules map with no model, authoring, false passes / fails across the variants,
// cosmetic heals, AI calls, tokens, list $ and wall time. Each style runs once
// (the MODEL RULE: no retry loops).

export const CORPUS_VERSION = 1;
export type CorpusRoute = "file" | "description";
export const CORPUS_FIXTURES = ["shop", "android"] as const;
export type CorpusFixture = (typeof CORPUS_FIXTURES)[number];

export interface CorpusStyle {
  id: string;
  imitates: string;
  routes: CorpusRoute[];
}

export interface CorpusEntry {
  fixture: CorpusFixture;
  style: string;
  /** The gold test's name (bench/fixtures/<fixture>/tests/<gold>.test.md). */
  gold: string;
  /** Repository-relative path of the entry (the gold file for `tidy`). */
  path: string;
  /** The whole file. */
  text: string;
}

const PASSWORD = "shop-demo-pass";

/** bench/corpus/styles.yaml */
export function loadStyles(benchDir: string): CorpusStyle[] {
  const file = join(benchDir, "corpus", "styles.yaml");
  const parsed = parseYaml(readFileSync(file, "utf8"), "styles.yaml").value as {
    styles: Record<string, { imitates: string; routes: CorpusRoute[] }>;
  };
  return Object.entries(parsed.styles).map(([id, s]) => ({
    id,
    imitates: s.imitates,
    routes: s.routes,
  }));
}

const goldNames = (benchDir: string, fixture: CorpusFixture) =>
  readdirSync(join(benchDir, "fixtures", fixture, "tests"))
    .filter((f) => f.endsWith(".test.md"))
    .map((f) => f.replace(/\.test\.md$/, ""))
    .sort();

/**
 * Every corpus entry. `tidy` is the gold test itself; for the Android fixture
 * the tidy control covers the same gold tests as its other styles.
 */
export function loadCorpus(benchDir: string): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  for (const fixture of CORPUS_FIXTURES) {
    const root = join(benchDir, "corpus", fixture);
    if (!existsSync(root)) continue;
    const styles = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const covered = new Set<string>();
    for (const style of styles)
      for (const file of readdirSync(join(root, style)).filter((f) => f.endsWith(".test.md"))) {
        const gold = file.replace(/\.test\.md$/, "");
        covered.add(gold);
        const path = `corpus/${fixture}/${style}/${file}`;
        out.push({
          fixture,
          style,
          gold,
          path,
          text: readFileSync(join(benchDir, path), "utf8"),
        });
      }
    const golds = fixture === "shop" ? goldNames(benchDir, fixture) : [...covered].sort();
    for (const gold of golds) {
      const path = `fixtures/${fixture}/tests/${gold}.test.md`;
      out.push({
        fixture,
        style: "tidy",
        gold,
        path,
        text: readFileSync(join(benchDir, path), "utf8"),
      });
    }
  }
  return out;
}

/** The front matter block of a test file ("" when there is none). */
export function frontMatterOf(text: string): string {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)?.[0] ?? "";
}

/** What a developer would type into `new` / Describe it: the body without comments or step numbers. */
export function descriptionOf(text: string): string {
  return text
    .slice(frontMatterOf(text).length)
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s{0,3}\d+[.)]\s+/, "").trim())
    .filter((line) => line !== "")
    .join("\n");
}

// ── the static part: lint and phrase rules, no browser, no model ────────────────

/** An action line that reads like a check: it would run as an action, not a check. */
const CHECK_WORDS =
  /\b(?:should|must|expect(?:ed|s)?\b|ensure that|make sure that|still (?:shows?|says?|there|listed|in the)|(?:is|are) (?:still )?(?:shown|visible|displayed))\b/i;

export interface EntryLint {
  status: "clean" | "warnings" | "rejected";
  /** "error:CODE" / "warning:rule" per finding (deduplicated, sorted). */
  reasons: string[];
  /** Runnable steps written in the test (flows count as one; guards not counted). */
  steps: number;
  expects: number;
  guards: number;
  /** Expect lines whose phrasing a check rule matches (compiled with no model). */
  expectsByRules: number;
  /** Action steps that read like a check: they run as actions, so nothing asserts them. */
  unmarkedChecks: number;
}

const textOf = (step: ReturnType<typeof specSteps>[number]) =>
  "text" in step ? step.text.raw : "";

export function summarizeSpec(spec: TestSpec, findings: readonly Finding[]): EntryLint {
  const steps = specSteps(spec);
  const runnable = steps.filter((s) => s.kind !== "guard");
  const expects = steps.filter((s) => s.kind === "expect");
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  const reasons = [
    ...new Set(
      findings.filter((f) => f.severity !== "info").map((f) => `${f.severity}:${f.rule ?? f.code}`),
    ),
  ].sort();
  return {
    status:
      errors.length > 0 || runnable.length === 0
        ? "rejected"
        : warnings.length > 0
          ? "warnings"
          : "clean",
    reasons,
    steps: runnable.length,
    expects: expects.length,
    guards: steps.filter((s) => s.kind === "guard").length,
    expectsByRules: expects.filter((s) => matchRules(textOf(s)).length > 0).length,
    unmarkedChecks: steps.filter((s) => s.kind === "action" && CHECK_WORDS.test(textOf(s))).length,
  };
}

/** Lints one test text as `tests/<gold>.test.md` of a fixture project (flows read from the fixture). */
export async function lintAs(
  fixtureDir: string,
  config: Config | undefined,
  gold: string,
  text: string,
): Promise<{ lint: EntryLint; spec: TestSpec; findings: Finding[] }> {
  const path = `tests/${gold}.test.md`;
  const read = nodeFileReader(fixtureDir);
  const checked = await checkTest(text, path, {
    readFile: (p) => (p === path ? text : read(p)),
    config,
    testsDir: "tests",
  });
  const project = lintProject([{ path, spec: checked.spec, expanded: checked.expanded }], config);
  // Project rules about the whole suite (e.g. unused flows) say nothing about this entry.
  const findings = [
    ...checked.findings,
    ...project.filter((f) => f.file === path && f.rule !== "unused-flow"),
  ];
  return { lint: summarizeSpec(checked.spec, findings), spec: checked.spec, findings };
}

export interface StaticStyleSummary {
  fixture: CorpusFixture;
  style: string;
  entries: number;
  lint: { clean: number; warnings: number; rejected: number; reasons: Record<string, number> };
  phrases: { expects: number; byRules: number; unmarkedChecks: number };
  perEntry: Array<{ gold: string } & EntryLint>;
}

const fixtureDirOf = (benchDir: string, fixture: CorpusFixture) =>
  join(benchDir, "fixtures", fixture);

/** Lint and phrase-rule numbers for every style (deterministic: no browser, no model). */
export async function analyzeCorpus(
  benchDir: string,
  entries: readonly CorpusEntry[] = loadCorpus(benchDir),
): Promise<StaticStyleSummary[]> {
  const configs = new Map<CorpusFixture, Config | undefined>();
  const out = new Map<string, StaticStyleSummary>();
  for (const entry of entries) {
    if (!configs.has(entry.fixture)) {
      const dir = fixtureDirOf(benchDir, entry.fixture);
      configs.set(entry.fixture, loadProject(dir, { env: {} }).config);
    }
    const { lint } = await lintAs(
      fixtureDirOf(benchDir, entry.fixture),
      configs.get(entry.fixture),
      entry.gold,
      entry.text,
    );
    const key = `${entry.fixture}/${entry.style}`;
    let summary = out.get(key);
    if (!summary) {
      summary = {
        fixture: entry.fixture,
        style: entry.style,
        entries: 0,
        lint: { clean: 0, warnings: 0, rejected: 0, reasons: {} },
        phrases: { expects: 0, byRules: 0, unmarkedChecks: 0 },
        perEntry: [],
      };
      out.set(key, summary);
    }
    summary.entries++;
    summary.lint[lint.status]++;
    for (const r of lint.reasons) summary.lint.reasons[r] = (summary.lint.reasons[r] ?? 0) + 1;
    summary.phrases.expects += lint.expects;
    summary.phrases.byRules += lint.expectsByRules;
    summary.phrases.unmarkedChecks += lint.unmarkedChecks;
    summary.perEntry.push({ gold: entry.gold, ...lint });
  }
  for (const s of out.values()) s.perEntry.sort((a, b) => (a.gold < b.gold ? -1 : 1));
  return [...out.values()].sort((a, b) =>
    a.fixture === b.fixture
      ? styleOrder(a.style) - styleOrder(b.style)
      : a.fixture < b.fixture
        ? 1
        : -1,
  );
}

const ORDER = ["tidy", "terse", "verbose", "acceptance", "gherkin", "spoken", "sloppy", "mixed"];
const styleOrder = (s: string) => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length);

// ── the run ─────────────────────────────────────────────────────────────────────

export interface CorpusEntryResult {
  gold: string;
  lint: EntryLint;
  /** Description route: the draft's status and calls (null on the file route). */
  draft: {
    status: string;
    lintClean: boolean;
    calls: number;
    listUsd: number | null;
    wallMs: number;
  } | null;
  /** The verdict of the run that authored it (correct). */
  authored: string | null;
  authoring: CallTotals & { wallMs: number };
  /** Per variant: verdict and how it scored against the manifest. */
  variants: Record<string, { verdict: string; expected: string; score: string }>;
}

export interface CorpusStyleResult {
  fixture: CorpusFixture;
  style: string;
  route: CorpusRoute;
  entries: number;
  lint: StaticStyleSummary["lint"];
  phrases: StaticStyleSummary["phrases"];
  drafts: { drafts: number; ok: number; lintClean: number } & CallTotals & { wallMs: number };
  authoring: { tests: number; passed: number; wallMs: number } & CallTotals;
  falsePass: Rate & { cases: string[] };
  falseFail: Rate & { cases: string[] };
  otherMismatches: string[];
  cosmetic: {
    tests: number;
    passedOrHealed: number;
    healedByFixer: number;
    healsWithoutAi: number;
    needsAi: number;
  } & CallTotals;
  /** All AI of this style: drafts + authoring + cosmetic. */
  total: CallTotals & { wallMs: number };
  perEntry: CorpusEntryResult[];
  problem: string | null;
}

export interface CorpusFile {
  corpusVersion: typeof CORPUS_VERSION;
  kind: "corpus";
  date: string;
  engineVersion: string;
  commit: string | null;
  os: string;
  scripted: boolean;
  model: string;
  command: string;
  /** How it was measured, in words (same header idea as EVAL-0). */
  measured: string[];
  styles: CorpusStyleResult[];
}

export interface CorpusOptions {
  entry: ModelEntry;
  /**
   * A stand-in model that gives up on every step (CI, rehearsal). The committed
   * recordings are kept, so an entry whose steps read like the gold test's replays
   * them: the tidy control reproduces the gold verdicts.
   */
  scripted?: boolean;
  fixtures?: readonly CorpusFixture[];
  styles?: readonly string[];
  /** Only these gold tests. */
  tests?: readonly string[];
  /** Only this route (default: every route the style lists). */
  route?: CorpusRoute;
  /** Skip the cosmetic heal pass. */
  noCosmetic?: boolean;
  budgetUsd?: number;
  env?: NodeJS.ProcessEnv;
  command?: string;
  now?: () => Date;
  onProgress?: (line: string) => void;
  /** Called after each style, so a crash later loses nothing. */
  onSave?: (file: CorpusFile) => void;
}

const callsOf = (test: TestResult): ModelCall[] => test.attempts.flatMap((a) => a.modelCalls);

/** Calls at list prices; the scripted stand-in has no price and costs nothing. */
function priced(options: CorpusOptions, calls: readonly ModelCall[]): CallTotals {
  const t = totals(calls, options.entry.model);
  return options.scripted ? { ...t, listUsd: 0 } : t;
}
const runCalls = (options: CorpusOptions, run: RunTestsResult) =>
  priced(options, run.tests.flatMap(callsOf));

/** The slice of corpus a run covers, by fixture and style. */
export function selectEntries(
  entries: readonly CorpusEntry[],
  options: Pick<CorpusOptions, "fixtures" | "styles" | "tests">,
): CorpusEntry[] {
  return entries.filter(
    (e) =>
      (!options.fixtures || options.fixtures.includes(e.fixture)) &&
      (!options.styles?.length || options.styles.includes(e.style)) &&
      (!options.tests?.length || options.tests.includes(e.gold)),
  );
}

/** The project copy a style runs in: the fixture with its gold tests replaced by the entries. */
export function styleProject(
  fixtureDir: string,
  entries: readonly { gold: string; text: string }[],
  keepRecordings: boolean,
): string {
  const dir = projectCopy(fixtureDir, "corpus-");
  if (!keepRecordings) withoutRecordings(dir);
  const keep = new Set(entries.map((e) => `${e.gold}.test.md`));
  for (const file of readdirSync(join(dir, "tests")))
    if (file.endsWith(".test.md") && !keep.has(file)) rmSync(join(dir, "tests", file));
  for (const entry of entries)
    writeFileSync(join(dir, "tests", `${entry.gold}.test.md`), entry.text);
  return dir;
}

/** Drafts each entry's description on the correct build (seeded like its first attempt). */
async function draftEntries(
  runner: FixtureRunner,
  fixtureDir: string,
  entries: readonly CorpusEntry[],
  options: CorpusOptions,
  budget: BudgetMeter,
  say: (line: string) => void,
): Promise<
  Map<
    string,
    { text: string | null; draft: NonNullable<CorpusEntryResult["draft"]>; calls: ModelCall[] }
  >
> {
  const out = new Map<
    string,
    { text: string | null; draft: NonNullable<CorpusEntryResult["draft"]>; calls: ModelCall[] }
  >();
  if (runner.id !== "shop") {
    for (const e of entries)
      out.set(e.gold, {
        text: null,
        draft: { status: "not_supported", lintClean: false, calls: 0, listUsd: 0, wallMs: 0 },
        calls: [],
      });
    say("descriptions: drafting is web only; Android entries take the file route");
    return out;
  }
  const shop = await shopFixture();
  const browser = await import("@optestra/browser");
  const server = await shop.module.startShop({ variant: "correct", port: 0 });
  const launched = await browser.launchBrowser({ browser: "chromium", headless: true });
  const dir = projectCopy(fixtureDir, "corpus-draft-");
  try {
    for (const entry of entries) {
      const fm = parseFrontMatter(entry.text);
      // The gold harness: a fresh environment, then the test's setup requests.
      const session = await browser.openSession({
        browser: launched,
        baseUrl: server.url,
        allowedDomains: ["127.0.0.1"],
      });
      try {
        await session.hookRequest({ method: "POST", target: "/__test/reset?environment=1" });
        for (const hook of fm.setup)
          await session.hookRequest({
            method: hook.method,
            target: hook.target,
            ...(hook.body === undefined ? {} : { body: hook.body }),
          });
      } finally {
        await session.close();
      }
      const started = Date.now();
      const result = await draftTest(descriptionOf(entry.text), {
        project: dir,
        baseUrl: server.url,
        start: fm.start,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SHOP_PASSWORD: PASSWORD },
        models: await modelsFor(dir, options.entry, options, budget),
      });
      const t = priced(options, result.modelCalls);
      const body = result.text.slice(frontMatterOf(result.text).length).trim();
      out.set(entry.gold, {
        text: body ? `${frontMatterOf(entry.text)}\n${body}\n` : null,
        draft: {
          status: result.status,
          lintClean: result.lintClean,
          calls: t.calls,
          listUsd: t.listUsd,
          wallMs: Date.now() - started,
        },
        calls: result.modelCalls,
      });
      say(`  draft ${entry.gold}: ${result.status}, ${t.calls} calls`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await launched.close();
    await server.stop();
  }
  return out;
}

/** The parts of the gold front matter the harness needs before drafting. */
function parseFrontMatter(text: string): {
  start: string | undefined;
  setup: { method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE"; target: string; body?: unknown }[];
} {
  const block = frontMatterOf(text)
    .replace(/^---\r?\n/, "")
    .replace(/\r?\n---\r?\n$/, "");
  const value = (parseYaml(block, "front matter").value ?? {}) as {
    start?: string;
    setup?: Array<{ request?: string; body?: unknown }>;
  };
  const setup = (value.setup ?? []).flatMap((s) => {
    const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/.exec(s.request ?? "");
    return m
      ? [
          {
            method: m[1] as "POST",
            target: m[2] as string,
            ...(s.body === undefined ? {} : { body: s.body }),
          },
        ]
      : [];
  });
  return { start: value.start, setup };
}

async function runStyle(
  runner: FixtureRunner,
  fixtureDir: string,
  style: string,
  route: CorpusRoute,
  entries: readonly CorpusEntry[],
  config: Config | undefined,
  options: CorpusOptions,
  say: (line: string) => void,
): Promise<CorpusStyleResult> {
  const budget = new BudgetMeter("run", options.budgetUsd ?? 10, "bench --corpus budget");
  const scripted = options.scripted ?? false;
  const lints = new Map<string, EntryLint>();
  const staticSummary: StaticStyleSummary = {
    fixture: runner.id,
    style,
    entries: entries.length,
    lint: { clean: 0, warnings: 0, rejected: 0, reasons: {} },
    phrases: { expects: 0, byRules: 0, unmarkedChecks: 0 },
    perEntry: [],
  };
  for (const e of entries) {
    const { lint } = await lintAs(fixtureDir, config, e.gold, e.text);
    lints.set(e.gold, lint);
    staticSummary.lint[lint.status]++;
    for (const r of lint.reasons)
      staticSummary.lint.reasons[r] = (staticSummary.lint.reasons[r] ?? 0) + 1;
    staticSummary.phrases.expects += lint.expects;
    staticSummary.phrases.byRules += lint.expectsByRules;
    staticSummary.phrases.unmarkedChecks += lint.unmarkedChecks;
  }

  // The texts that get authored: the entries themselves, or their drafts.
  let drafts: Awaited<ReturnType<typeof draftEntries>> | null = null;
  let texts = entries.map((e) => ({ gold: e.gold, text: e.text }));
  if (route === "description") {
    say(`${runner.id}/${style} (description): drafting ${entries.length} tests…`);
    drafts = await draftEntries(runner, fixtureDir, entries, options, budget, say);
    texts = entries.flatMap((e) => {
      const text = drafts?.get(e.gold)?.text;
      return text ? [{ gold: e.gold, text }] : [];
    });
  }
  const draftCalls = [...(drafts?.values() ?? [])].flatMap((d) => d.calls);
  const draftTotals = {
    drafts: drafts?.size ?? 0,
    ok: [...(drafts?.values() ?? [])].filter((d) => d.draft.status === "ok" || d.text !== null)
      .length,
    lintClean: [...(drafts?.values() ?? [])].filter((d) => d.draft.lintClean).length,
    ...priced(options, draftCalls),
    wallMs: [...(drafts?.values() ?? [])].reduce((n, d) => n + d.draft.wallMs, 0),
  };

  const perEntry = new Map<string, CorpusEntryResult>();
  for (const e of entries)
    perEntry.set(e.gold, {
      gold: e.gold,
      lint: lints.get(e.gold) as EntryLint,
      draft: drafts?.get(e.gold)?.draft ?? null,
      authored: null,
      authoring: { ...none(), wallMs: 0 },
      variants: {},
    });

  const empty = (n: number): Rate & { cases: string[] } => ({
    count: 0,
    of: n,
    rate: 0,
    cases: [],
  });
  const result: CorpusStyleResult = {
    fixture: runner.id,
    style,
    route,
    entries: entries.length,
    lint: staticSummary.lint,
    phrases: staticSummary.phrases,
    drafts: draftTotals,
    authoring: { tests: 0, passed: 0, wallMs: 0, ...none() },
    falsePass: empty(0),
    falseFail: empty(0),
    otherMismatches: [],
    cosmetic: {
      tests: 0,
      passedOrHealed: 0,
      healedByFixer: 0,
      healsWithoutAi: 0,
      needsAi: 0,
      ...none(),
    },
    total: { ...priced(options, draftCalls), wallMs: draftTotals.wallMs },
    perEntry: [],
    problem: null,
  };
  if (texts.length === 0) {
    result.problem = "nothing to author: every draft failed";
    result.perEntry = [...perEntry.values()];
    return result;
  }

  const dir = styleProject(fixtureDir, texts, scripted);
  try {
    // 1. Authoring on correct (scripted: the committed recordings replay where steps match).
    say(`${runner.id}/${style} (${route}): authoring ${texts.length} tests…`);
    const authored = await runner.run("correct", dir, {
      mode: "normal",
      retries: 0,
      models: await modelsFor(dir, options.entry, options, budget),
    });
    for (const t of authored.run.tests) {
      const gold = t.file.replace(/^tests\//, "").replace(/\.test\.md$/, "");
      const row = perEntry.get(gold);
      if (!row) continue;
      row.authored = t.verdict;
      row.authoring = { ...priced(options, callsOf(t)), wallMs: t.durationMs };
    }
    const authoringTotals = runCalls(options, authored.run);
    result.authoring = {
      tests: authored.run.tests.length,
      passed: authored.run.tests.filter((t) => t.verdict === "passed").length,
      wallMs: authored.ms,
      ...authoringTotals,
    };
    const blocked = authored.run.tests.find((t) =>
      t.decidedBy.some(
        (d) =>
          d.kind === "blocked" && (d.reason === "ai_unavailable" || d.reason === "budget_exceeded"),
      ),
    );
    if (blocked) result.problem = `authoring was blocked: ${blocked.headline ?? ""}`;

    // 2. Its recordings with no AI on every variant but cosmetic.
    const rows: BenchRow[] = [];
    for (const variant of runner.variants.filter((v) => v !== "cosmetic")) {
      const replayed = await runner.run(variant, dir, {});
      rows.push(
        ...(await rowsOf(runner.id as FixtureId, runner.manifest, variant, 1, replayed.run, dir)),
      );
    }
    // 3. Cosmetic in normal mode, the model as fixer.
    let cosmeticTotals = none();
    if (!options.noCosmetic) {
      // Scripted: no fixer, like Bench, so a miss only AI could heal counts as "needs AI".
      const cosmetic = await runner.run("cosmetic", dir, {
        mode: "normal",
        models: scripted ? null : await modelsFor(dir, options.entry, options, budget),
      });
      rows.push(
        ...(await rowsOf(
          runner.id as FixtureId,
          runner.manifest,
          "cosmetic",
          1,
          cosmetic.run,
          dir,
        )),
      );
      const heals = Object.values(cosmetic.run.heals);
      cosmeticTotals = runCalls(options, cosmetic.run);
      result.cosmetic = {
        tests: cosmetic.run.tests.length,
        passedOrHealed: cosmetic.run.tests.filter(
          (t) => t.verdict === "passed" || t.verdict === "healed",
        ).length,
        healedByFixer: heals.reduce((n, h) => n + h.byFixer, 0),
        healsWithoutAi: heals.reduce((n, h) => n + h.withoutAi, 0),
        needsAi: heals.reduce((n, h) => n + h.needsAi, 0),
        ...cosmeticTotals,
      };
    }
    for (const row of rows) {
      const entry = perEntry.get(row.test);
      if (entry)
        entry.variants[row.variant] = {
          verdict: row.verdict,
          expected: row.expected.verdict,
          score: row.score,
        };
    }
    const metrics = fixtureMetrics(rows);
    result.falsePass = metrics.falsePass;
    result.falseFail = metrics.falseFail;
    result.otherMismatches = metrics.otherMismatches;
    const all = add(add(priced(options, draftCalls), authoringTotals), cosmeticTotals);
    result.total = { ...all, wallMs: draftTotals.wallMs + authored.ms };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  result.perEntry = [...perEntry.values()];
  say(
    `${runner.id}/${style} (${route}): ${result.authoring.passed}/${result.authoring.tests} authored, false pass ${result.falsePass.count}/${result.falsePass.of}, false fail ${result.falseFail.count}/${result.falseFail.of}, ${result.total.calls} calls`,
  );
  return result;
}

export async function runCorpus(options: CorpusOptions): Promise<CorpusFile> {
  const say = options.onProgress ?? (() => {});
  const shop = await shopFixture();
  const benchDir = shop.benchDir;
  const styles = loadStyles(benchDir);
  const fixtures = options.fixtures ?? ["shop"];
  const all = selectEntries(loadCorpus(benchDir), { ...options, fixtures });
  const scripted = options.scripted ?? false;
  const file: CorpusFile = {
    corpusVersion: CORPUS_VERSION,
    kind: "corpus",
    date: (options.now?.() ?? new Date()).toISOString(),
    engineVersion: version(),
    commit: engineCommit(benchDir),
    os: `${process.platform} ${process.arch} (${cpus()[0]?.model ?? "cpu"}, ${cpus().length} cores)`,
    scripted,
    model: entryId(options.entry),
    command:
      options.command ??
      `bench --corpus --models ${entryId(options.entry)}${scripted ? " --scripted" : ""}`,
    measured: [
      `Each style runs once on ${fixtures.join(" and ")} with ${scripted ? "a scripted stand-in (no AI); the committed recordings are kept, so only entries that read like the gold test replay" : `${entryId(options.entry)} as planner and fixer; every test is authored from scratch`}.`,
      `Authoring: the correct build, normal mode, no retries. Replays: every other variant with the recordings that authoring made, no AI. Cosmetic: normal mode, ${scripted ? 'no fixer (as in Bench: a miss only AI could heal is "needs AI")' : "the model as fixer"}.`,
      "False pass / false fail are scored against the fixture's manifest (verdict and cause), as in Bench. Costs are at list API prices (packages/models/prices.yaml), also for calls billed to a subscription.",
    ],
    styles: [],
  };
  const useMailpit = await mailpitRunning();
  for (const fixture of fixtures) {
    const entries = all.filter((e) => e.fixture === fixture);
    if (entries.length === 0) continue;
    let runner: FixtureRunner;
    let fixtureDir: string;
    if (fixture === "shop") {
      runner = await shopRunner(shop, useMailpit);
      fixtureDir = shop.dir;
    } else {
      const check = await androidFixture(options.env ?? process.env);
      if (!check.ok) {
        say(`android: skipped (${check.reason})`);
        continue;
      }
      runner = await androidRunner(check.fixture, shop);
      fixtureDir = check.fixture.dir;
    }
    const config = loadProject(fixtureDir, { env: {} }).config;
    try {
      for (const style of styles) {
        const slice = entries.filter((e) => e.style === style.id);
        if (slice.length === 0) continue;
        const routes = options.route ? [options.route] : style.routes;
        for (const route of routes) {
          file.styles.push(
            await runStyle(runner, fixtureDir, style.id, route, slice, config, options, say),
          );
          options.onSave?.(file);
        }
      }
    } finally {
      await runner.close();
    }
  }
  return file;
}

/** Writes bench/results/<date>-corpus-<models|scripted>.json; returns the path. */
export function saveCorpus(benchDir: string, file: CorpusFile): string {
  mkdirSync(join(benchDir, "results"), { recursive: true });
  const path = join(
    benchDir,
    "results",
    `${file.date.slice(0, 10)}-corpus-${file.scripted ? "scripted" : "models"}.json`,
  );
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}

// ── the estimate (asked before a real run) ────────────────────────────────────────

export interface CorpusEstimate {
  /** The measured per-test numbers the estimate scales (from the newest model comparison). */
  basis: {
    file: string | null;
    model: string;
    fixture: Record<
      CorpusFixture,
      {
        callsPerTest: number;
        usdPerTest: number;
        sPerTest: number;
        healCalls: number;
        healUsd: number;
      }
    >;
    draft: { calls: number; usd: number; s: number };
  };
  rows: Array<{
    fixture: CorpusFixture;
    style: string;
    route: CorpusRoute;
    tests: number;
    /** Entries lint rejects on this route: blocked before any AI call. */
    rejected: number;
    calls: number;
    usd: number;
    minutes: number;
  }>;
  total: { calls: number; usd: number; minutes: number };
}

/** EVAL-0's Sonnet 5.5 numbers, used when no comparison file is found. */
const FALLBACK = {
  shop: { callsPerTest: 9.4, usdPerTest: 0.047, sPerTest: 28, healCalls: 2, healUsd: 0.0114 },
  android: { callsPerTest: 9.3, usdPerTest: 0.047, sPerTest: 45, healCalls: 1, healUsd: 0.0078 },
  draft: { calls: 8, usd: 0.045, s: 60 },
};

function basisFrom(benchDir: string, model: string): CorpusEstimate["basis"] {
  const dir = join(benchDir, "results");
  // Model comparisons (EVAL-0's -model-comparison, EVAL-1's -open-models), newest first.
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith("-model-comparison.json") || f.endsWith("-open-models.json"))
        .sort()
        .reverse()
    : [];
  const basis: CorpusEstimate["basis"] = {
    file: null,
    model,
    fixture: { shop: { ...FALLBACK.shop }, android: { ...FALLBACK.android } },
    draft: { ...FALLBACK.draft },
  };
  type Parsed = {
    models: Array<{
      model: string;
      fixtures: Array<{
        fixture: CorpusFixture;
        quality: { tests: number };
        authoring: { calls: number; listUsd: number | null; wallMs: number };
        heals: { calls: number; listUsd: number | null };
      }>;
      drafts?: Array<{ calls: number; listUsd: number | null; wallMs: number }>;
    }>;
  };
  // Each fixture (and the drafts) from the newest comparison that measured it.
  const seen = new Set<string>();
  for (const file of files) {
    let m: Parsed["models"][number] | undefined;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as Parsed;
      m = parsed.models.find((x) => x.model.endsWith(`:${model}`) || x.model === model);
    } catch {
      m = undefined;
    }
    if (!m) continue;
    for (const f of m.fixtures) {
      if (seen.has(f.fixture)) continue;
      seen.add(f.fixture);
      basis.file ??= `bench/results/${file}`;
      const n = Math.max(1, f.quality.tests);
      basis.fixture[f.fixture] = {
        callsPerTest: f.authoring.calls / n,
        usdPerTest: (f.authoring.listUsd ?? 0) / n,
        sPerTest: f.authoring.wallMs / 1000 / n,
        healCalls: f.heals.calls,
        healUsd: f.heals.listUsd ?? 0,
      };
    }
    if (m.drafts?.length && !seen.has("draft")) {
      seen.add("draft");
      const d = m.drafts;
      basis.draft = {
        calls: d.reduce((s, x) => s + x.calls, 0) / d.length,
        usd: d.reduce((s, x) => s + (x.listUsd ?? 0), 0) / d.length,
        s: d.reduce((s, x) => s + x.wallMs, 0) / 1000 / d.length,
      };
    }
  }
  return basis;
}

/**
 * Calls, list $ and minutes a real corpus run should take: per style and route,
 * authoring every test (the measured per-test numbers), the cosmetic heals once,
 * and for descriptions a draft per test. Replays cost no AI.
 */
export async function estimateCorpus(
  benchDir: string,
  options: Pick<CorpusOptions, "fixtures" | "styles" | "tests" | "route" | "noCosmetic"> & {
    model: string;
  },
): Promise<CorpusEstimate> {
  const basis = basisFrom(benchDir, options.model);
  const styles = loadStyles(benchDir);
  const entries = selectEntries(loadCorpus(benchDir), {
    ...options,
    fixtures: options.fixtures ?? ["shop"],
  });
  // A test file that lint rejects (no steps, an error) is blocked before any AI call.
  const rejected = new Set<string>();
  for (const s of await analyzeCorpus(benchDir, entries))
    for (const e of s.perEntry)
      if (e.status === "rejected") rejected.add(`${s.fixture}/${s.style}/${e.gold}`);
  const rows: CorpusEstimate["rows"] = [];
  for (const fixture of CORPUS_FIXTURES)
    for (const style of styles) {
      const slice = entries.filter((e) => e.fixture === fixture && e.style === style.id);
      if (slice.length === 0) continue;
      const routes = options.route ? [options.route] : style.routes;
      for (const route of routes) {
        if (route === "description" && fixture !== "shop") continue;
        const tests =
          route === "file"
            ? slice.filter((e) => !rejected.has(`${fixture}/${style.id}/${e.gold}`)).length
            : slice.length;
        const b = basis.fixture[fixture];
        const fullTests = fixture === "shop" ? 11 : 7;
        const heal = options.noCosmetic ? 0 : tests / fullTests;
        let calls = tests * b.callsPerTest + heal * b.healCalls;
        let usd = tests * b.usdPerTest + heal * b.healUsd;
        // Replays: about 0.8 s (web) / 18 s (Android) per test and variant.
        let seconds = tests * b.sPerTest + tests * (fixture === "shop" ? 8 * 1.5 : 6 * 20);
        if (route === "description") {
          calls += tests * basis.draft.calls;
          usd += tests * basis.draft.usd;
          seconds += tests * basis.draft.s;
        }
        rows.push({
          fixture,
          style: style.id,
          route,
          tests,
          rejected: slice.length - (route === "file" ? tests : slice.length),
          calls: Math.round(calls),
          usd: Math.round(usd * 1000) / 1000,
          minutes: Math.round((seconds / 60) * 10) / 10,
        });
      }
    }
  const total = rows.reduce(
    (t, r) => ({ calls: t.calls + r.calls, usd: t.usd + r.usd, minutes: t.minutes + r.minutes }),
    { calls: 0, usd: 0, minutes: 0 },
  );
  total.usd = Math.round(total.usd * 100) / 100;
  total.minutes = Math.round(total.minutes);
  return { basis, rows, total };
}

// ── formatting ────────────────────────────────────────────────────────────────────

const pct = (r: Rate) => `${r.count}/${r.of}`;
const money = (n: number | null) => (n === null ? "?" : `$${n.toFixed(3)}`);

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((r, n) => {
      const line = `| ${r.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;
      return n === 0 ? `${line}\n|${widths.map((w) => "-".repeat(w + 2)).join("|")}|` : line;
    })
    .join("\n");
}

export function formatStatic(summaries: readonly StaticStyleSummary[]): string {
  const rows = [
    [
      "Fixture",
      "Style",
      "Entries",
      "Lint clean / warn / rejected",
      "Expects by rules",
      "Unmarked checks",
      "Top reasons",
    ],
  ];
  for (const s of summaries) {
    const top = Object.entries(s.lint.reasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, n]) => `${r} ×${n}`)
      .join(", ");
    rows.push([
      s.fixture,
      s.style,
      String(s.entries),
      `${s.lint.clean} / ${s.lint.warnings} / ${s.lint.rejected}`,
      `${s.phrases.byRules}/${s.phrases.expects}`,
      String(s.phrases.unmarkedChecks),
      top || "–",
    ]);
  }
  return table(rows);
}

export function formatCorpus(file: CorpusFile): string {
  const head = [
    `Corpus (${file.model}${file.scripted ? ", scripted" : ""}) · engine ${file.engineVersion}${file.commit ? ` at ${file.commit.slice(0, 7)}` : ""} · ${file.os} · ${file.date.slice(0, 10)}`,
    ...file.measured,
    `Reproduce: ${brand.cliName} ${file.command}`,
    "",
  ];
  const rows = [
    [
      "Fixture",
      "Style",
      "Route",
      "Lint ok/warn/rej",
      "Expects by rules",
      "Drafted",
      "Authored passed",
      "False pass",
      "False fail",
      "Cosmetic",
      "Calls",
      "List $",
      "Wall s",
    ],
  ];
  for (const s of file.styles)
    rows.push([
      s.fixture,
      s.style,
      s.route,
      `${s.lint.clean}/${s.lint.warnings}/${s.lint.rejected}`,
      `${s.phrases.byRules}/${s.phrases.expects}`,
      s.route === "description" ? `${s.drafts.ok}/${s.drafts.drafts}` : "–",
      `${s.authoring.passed}/${s.authoring.tests}`,
      pct(s.falsePass),
      pct(s.falseFail),
      `${s.cosmetic.passedOrHealed}/${s.cosmetic.tests}${s.cosmetic.needsAi ? ` (${s.cosmetic.needsAi} need AI)` : ""}`,
      String(s.total.calls),
      money(s.total.listUsd),
      String(Math.round(s.total.wallMs / 1000)),
    ]);
  const problems = file.styles
    .filter((s) => s.problem || s.otherMismatches.length > 0)
    .map(
      (s) =>
        `- ${s.fixture}/${s.style} (${s.route}): ${[s.problem, ...s.otherMismatches.slice(0, 5)].filter(Boolean).join("; ")}`,
    );
  return [...head, table(rows), ...(problems.length ? ["", "Notes:", ...problems] : [])].join("\n");
}

export function formatEstimate(estimate: CorpusEstimate): string {
  const rows = [
    [
      "Fixture",
      "Style",
      "Route",
      "Tests authored",
      "Rejected by lint",
      "Calls",
      "List $",
      "Minutes",
    ],
  ];
  for (const r of estimate.rows)
    rows.push([
      r.fixture,
      r.style,
      r.route,
      String(r.tests),
      String(r.rejected),
      String(r.calls),
      `$${r.usd.toFixed(2)}`,
      String(r.minutes),
    ]);
  rows.push([
    "total",
    "",
    "",
    "",
    "",
    String(estimate.total.calls),
    `$${estimate.total.usd.toFixed(2)}`,
    String(estimate.total.minutes),
  ]);
  return [
    `Estimate for ${estimate.basis.model}, from ${estimate.basis.file ?? "EVAL-0's Sonnet 5.5 numbers"} (per test: shop ${estimate.basis.fixture.shop.callsPerTest.toFixed(1)} calls / $${estimate.basis.fixture.shop.usdPerTest.toFixed(3)}, android ${estimate.basis.fixture.android.callsPerTest.toFixed(1)} calls / $${estimate.basis.fixture.android.usdPerTest.toFixed(3)}; a draft ${estimate.basis.draft.calls.toFixed(1)} calls / $${estimate.basis.draft.usd.toFixed(3)}).`,
    table(rows),
  ].join("\n");
}
