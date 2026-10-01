import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { brand } from "@optestra/brand";
import { type Config, hasErrors } from "@optestra/config";
import { loadProject } from "@optestra/config/node";
import type { RunMode, Trigger } from "@optestra/contract";
import { recordingBranch, recordingFiles } from "@optestra/recording/node";
import { buildResultsSummary, resultsSummaryJsonSchema } from "@optestra/report";
import { checkTest, type Finding } from "@optestra/spec";
import { loadTests, nodeFileReader } from "@optestra/spec/node";
import { z } from "zod";
import type { ToolResult, ToolSpec } from "./protocol.js";

// The MCP tools (AGT-1). They work on one local project folder. None of them
// edits an existing test: `save_test` writes new files only, and there is no
// tool that changes an `Expect:` line (AGT-2, AGT-4). `accept_heal` goes
// through the HEAL-0 API, which changes a step's commands and never a check.

type CoreNode = typeof import("@optestra/core/node");

export interface ToolContext {
  /** The project folder. */
  project: string;
  /** Default environment for runs and drafts (else the project's default). */
  environment?: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  /** The engine's Node API; tests inject fakes. Default: @optestra/core/node. */
  core?: () => Promise<
    Pick<CoreNode, "runTests" | "draftTest" | "listHeals" | "applyHeals" | "explainRun">
  >;
  /** Engine runs headless unless this is false. */
  headless?: boolean;
}

class ToolError extends Error {}

const posix = (path: string) => path.split(sep).join("/");

interface Loaded {
  dir: string;
  config: Config;
  testsDir: string;
}

function project(ctx: ToolContext): Loaded {
  const dir = resolve(ctx.project);
  const loaded = loadProject(dir, { environment: ctx.environment, env: ctx.env });
  if (hasErrors(loaded.diagnostics))
    throw new ToolError(
      `The project settings have errors: ${loaded.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => `${d.code}: ${d.message} Fix: ${d.fix}`)
        .join(" ")}`,
    );
  return { dir, config: loaded.config, testsDir: loaded.config.tests?.dir ?? "tests" };
}

/** A test file path the agent gave, as a project-relative path inside the tests folder. */
function testPath(p: Loaded, given: string): string {
  const raw = given.trim().replace(/\\/g, "/");
  if (!raw) throw new ToolError("path is empty.");
  if (isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    const rel = posix(relative(p.dir, raw));
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new ToolError(`${given} is outside the project.`);
    return testPath(p, rel);
  }
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw new ToolError(`${given}: ".." is not allowed in a test path.`);
  const inTests = parts[0] === p.testsDir ? parts : [p.testsDir, ...parts];
  if (inTests.includes(brand.dataDirName))
    throw new ToolError(
      `${given} is in the recordings folder (${brand.dataDirName}/), which is written by the engine only.`,
    );
  const path = inTests.join("/");
  if (!path.endsWith(".test.md")) throw new ToolError(`${given}: test files end in .test.md.`);
  return path;
}

const findingOf = (f: Finding) => ({
  severity: f.severity,
  code: f.code,
  rule: f.rule ?? null,
  message: f.message,
  fix: f.fix,
  line: f.range?.start.line ?? null,
});

const FindingSchema = z.object({
  severity: z.string(),
  code: z.string(),
  rule: z.string().nullable(),
  message: z.string(),
  fix: z.string(),
  line: z.number().nullable(),
});

async function runDirFor(p: Loaded, runId: string | undefined): Promise<string> {
  const { latestRunDir, runsDir } = await import("@optestra/report/node");
  if (runId) {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(runId))
      throw new ToolError(`"${runId}" is not a run id.`);
    const dir = join(runsDir(p.dir), runId.toUpperCase());
    if (!existsSync(dir)) throw new ToolError(`There is no run ${runId} in this project.`);
    return dir;
  }
  const latest = latestRunDir(p.dir);
  if (!latest) throw new ToolError("This project has no finished runs yet. Call run_tests first.");
  return latest;
}

/** The results summary of a run folder, plus each test's evidence files (absolute paths). */
async function resultsOf(runDir: string) {
  const { loadRunData } = await import("@optestra/report/node");
  const loaded = loadRunData(runDir);
  if (!loaded.ok)
    throw new ToolError(
      `The run in ${runDir} can't be read: ${loaded.diagnostics.map((d) => d.message).join("; ")}`,
    );
  const summary = buildResultsSummary(loaded.data);
  const evidence = loaded.data.tests.map((test) => {
    const last = test.attempts.at(-1);
    return {
      testId: test.testId,
      file: test.file,
      verdict: test.verdict,
      attempt: last?.attempt ?? null,
      files: (last?.artifacts ?? []).map((a) => ({
        kind: a.kind,
        path: join(runDir, ...a.path.split("/")),
      })),
    };
  });
  return { runDir, summary: summary as unknown as Record<string, unknown>, evidence };
}

// ── schemas ─────────────────────────────────────────────────────────────────

const jsonSchema = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest;
};

const summarySchema = (): Record<string, unknown> => {
  const { $schema: _, ...rest } = resultsSummaryJsonSchema();
  return rest;
};

const EvidenceSchema = z.array(
  z.object({
    testId: z.string(),
    file: z.string(),
    verdict: z.string(),
    attempt: z.number().nullable(),
    files: z.array(z.object({ kind: z.string(), path: z.string() })),
  }),
);

/** Results output: the run folder, the AGT-3 summary, and the evidence. */
const resultsOutput = (): Record<string, unknown> => ({
  type: "object",
  properties: {
    runDir: { type: "string" },
    summary: summarySchema(),
    evidence: jsonSchema(EvidenceSchema),
  },
  required: ["runDir", "summary", "evidence"],
});

const TestRowSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  tags: z.array(z.string()),
  steps: z.number(),
  recorded: z.boolean(),
  problems: z.number(),
});

const DraftOutput = z.object({
  saved: z.literal(false),
  status: z.enum(["drafted", "incomplete", "impossible", "stopped"]),
  reason: z.string().nullable(),
  message: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  text: z.string(),
  lintClean: z.boolean(),
  findings: z.array(FindingSchema),
  notes: z.array(z.string()),
  ai: z.object({ calls: z.number(), costUsd: z.number(), billing: z.string().nullable() }),
});

const HealSchema = z
  .object({
    id: z.string(),
    testId: z.string(),
    test: z.string(),
    file: z.string(),
    stepIndex: z.number(),
    step: z.string(),
    status: z.string(),
    classification: z.string(),
    behaviourChange: z.boolean(),
    confidence: z.number(),
    before: z.array(z.string()),
    after: z.array(z.string()),
    why: z.array(z.string()),
  })
  .loose();

const RunId = z
  .string()
  .optional()
  .describe("A run id (the run folder's name). Default: the latest run.");

// ── the tools ──────────────────────────────────────────────────────────────

interface Tool<I extends z.ZodType> {
  spec: Omit<ToolSpec, "inputSchema" | "outputSchema">;
  input: I;
  output: () => Record<string, unknown>;
  run(args: z.infer<I>, ctx: ToolContext, signal: AbortSignal): Promise<Record<string, unknown>>;
}

const tool = <I extends z.ZodType>(t: Tool<I>) => t;

const loadCore = (ctx: ToolContext) =>
  ctx.core ? ctx.core() : (import("@optestra/core/node") as Promise<CoreNode>);

export const TOOLS = [
  tool({
    spec: {
      name: "list_tests",
      title: "List tests",
      description:
        "List the project's tests: file, name, tags, number of steps, whether it has a recording, and how many problems lint finds.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    input: z.object({ tag: z.string().optional().describe("Only tests with this tag.") }).strict(),
    output: () =>
      jsonSchema(
        z.object({
          project: z.string(),
          testsDir: z.string(),
          tests: z.array(TestRowSchema),
          flows: z.array(z.object({ path: z.string(), name: z.string() })),
        }),
      ),
    async run(args, ctx) {
      const p = project(ctx);
      const loaded = await loadTests(p.dir, p.config, { environment: ctx.environment });
      const tests = loaded.tests
        .filter((t) => !args.tag || t.spec.frontmatter.tags.includes(args.tag))
        .map((t) => ({
          id: t.id,
          path: t.path,
          name: t.spec.frontmatter.name,
          tags: t.spec.frontmatter.tags,
          steps: t.expanded.steps.length,
          recorded: isRecorded(p.dir, p.testsDir, p.config, ctx.env, t.id),
          problems: t.diagnostics.length,
        }));
      return {
        project: p.dir,
        testsDir: loaded.dir,
        tests,
        flows: loaded.flows.map((f) => ({ path: f.path, name: f.spec.frontmatter.name })),
      };
    },
  }),

  tool({
    spec: {
      name: "get_test",
      title: "Read a test",
      description:
        "Read one test file: its text, its steps (Expect: lines are the checks) and what lint finds. Read-only.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    input: z
      .object({ path: z.string().describe("The test file, e.g. tests/login.test.md.") })
      .strict(),
    output: () =>
      jsonSchema(
        z.object({
          path: z.string(),
          name: z.string(),
          text: z.string(),
          steps: z.array(
            z.object({ number: z.number().nullable(), kind: z.string(), text: z.string() }),
          ),
          recorded: z.boolean(),
          findings: z.array(FindingSchema),
        }),
      ),
    async run(args, ctx) {
      const p = project(ctx);
      const path = testPath(p, args.path);
      const file = join(p.dir, ...path.split("/"));
      if (!existsSync(file)) throw new ToolError(`There is no test ${path}.`);
      const text = readFileSync(file, "utf8");
      const checked = await checkTest(text, path, {
        readFile: nodeFileReader(p.dir),
        config: p.config,
        environment: ctx.environment,
      });
      const loaded = await loadTests(p.dir, p.config, { environment: ctx.environment });
      const id = [...loaded.tests, ...loaded.flows].find((t) => t.path === path)?.id;
      return {
        path,
        name: checked.spec.frontmatter.name,
        text,
        steps: checked.expanded.steps.map((s) => ({
          number: s.number,
          kind: s.kind,
          text: s.display,
        })),
        recorded: id ? isRecorded(p.dir, p.testsDir, p.config, ctx.env, id) : false,
        findings: checked.findings.map(findingOf),
      };
    },
  }),

  tool({
    spec: {
      name: "draft_test",
      title: "Draft a test from a sentence",
      description:
        "Explore the running app in a browser and draft a test for one sentence (e.g. 'a returning user can log in'). Returns the draft text and where it would go; it does NOT save it (use save_test after reviewing it). Uses AI and takes up to a few minutes.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    input: z
      .object({
        sentence: z.string().min(3).describe("What the test should show, in one sentence."),
        start: z.string().optional().describe("Where to start, e.g. /login. Default /."),
        environment: z.string().optional(),
      })
      .strict(),
    output: () => jsonSchema(DraftOutput),
    async run(args, ctx, signal) {
      const p = project(ctx);
      const core = await loadCore(ctx);
      const draft = await core.draftTest(args.sentence, {
        project: p.dir,
        environment: args.environment ?? ctx.environment,
        start: args.start,
        env: ctx.env,
        headless: ctx.headless ?? true,
        signal,
      });
      return {
        saved: false,
        status: draft.status,
        reason: draft.reason ?? null,
        message: draft.message ?? null,
        name: draft.name,
        path: draft.path,
        text: draft.text,
        lintClean: draft.lintClean,
        findings: draft.findings.map(findingOf),
        notes: draft.notes,
        ai: {
          calls: draft.totals.aiCalls,
          costUsd: draft.totals.costUsd,
          billing: draft.totals.billing,
        },
      };
    },
  }),

  tool({
    spec: {
      name: "save_test",
      title: "Save a new test",
      description:
        "Save a NEW test file in the tests folder. Refuses to overwrite an existing file (existing tests and their Expect: lines are never changed by this server) and refuses text that lint finds errors or warnings in.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    input: z
      .object({
        path: z.string().describe("New file in the tests folder, e.g. tests/login.test.md."),
        text: z.string().min(1).describe("The whole .test.md text."),
      })
      .strict(),
    output: () =>
      jsonSchema(
        z.object({ saved: z.literal(true), path: z.string(), findings: z.array(FindingSchema) }),
      ),
    async run(args, ctx) {
      const p = project(ctx);
      const path = testPath(p, args.path);
      const file = join(p.dir, ...path.split("/"));
      if (existsSync(file))
        throw new ToolError(
          `${path} already exists. This server never changes an existing test (its Expect: lines are the specification). Choose a new file name; a human edits existing tests.`,
        );
      const text = args.text.endsWith("\n") ? args.text : `${args.text}\n`;
      const checked = await checkTest(text, path, {
        readFile: nodeFileReader(p.dir),
        config: p.config,
        environment: ctx.environment,
      });
      const blocking = checked.findings.filter(
        (f) => f.severity === "error" || f.severity === "warning",
      );
      if (blocking.length > 0)
        throw new ToolError(
          `Not saved: lint must pass first.\n${blocking
            .map(
              (f) =>
                `- line ${f.range?.start.line ?? "?"}: ${f.rule ?? f.code}: ${f.message} Fix: ${f.fix}`,
            )
            .join("\n")}`,
        );
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, { flag: "wx" });
      return { saved: true, path, findings: checked.findings.map(findingOf) };
    },
  }),

  tool({
    spec: {
      name: "run_tests",
      title: "Run tests",
      description:
        "Run tests against the running app (default: all). Replays each recording with no AI; an unrecorded step is authored with AI unless mode is replay-only. Returns the machine-readable summary: per test the verdict, the failure cause, the headline, the failing check (expectation, expected, actual), the failing step and the file.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    input: z
      .object({
        tests: z.array(z.string()).optional().describe("Test files or folders. Default: all."),
        tags: z.array(z.string()).optional(),
        grep: z.string().optional().describe("Only tests whose name contains this."),
        environment: z.string().optional(),
        mode: z
          .enum(["normal", "replay-only"])
          .optional()
          .describe("replay-only: no AI at all; a missed or unrecorded step fails."),
      })
      .strict(),
    output: resultsOutput,
    async run(args, ctx, signal) {
      const p = project(ctx);
      const tests = (args.tests ?? []).map((t) =>
        t.endsWith(".test.md") ? testPath(p, t) : posix(t),
      );
      const environment = args.environment ?? ctx.environment;
      const core = await loadCore(ctx);
      if (signal.aborted) throw new ToolError("Cancelled.");
      const result = await core.runTests({
        projectDir: p.dir,
        cwd: p.dir,
        ...(tests.length ? { tests } : {}),
        ...(args.tags?.length ? { tags: args.tags } : {}),
        ...(args.grep ? { grep: args.grep } : {}),
        ...(environment ? { environment } : {}),
        ...(args.mode ? { mode: args.mode as RunMode } : {}),
        env: ctx.env,
        headless: ctx.headless ?? true,
        trigger: "agent" as Trigger,
      });
      return resultsOf(result.dir);
    },
  }),

  tool({
    spec: {
      name: "get_results",
      title: "Get run results",
      description:
        "The results of a finished run (default: the latest): the machine-readable summary (verdicts, causes, failing checks and steps, files) and each test's evidence files (screenshots, trace, video, console, network), as absolute paths.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    input: z.object({ runId: RunId }).strict(),
    output: resultsOutput,
    async run(args, ctx) {
      const p = project(ctx);
      return resultsOf(await runDirFor(p, args.runId));
    },
  }),

  tool({
    spec: {
      name: "explain",
      title: "Explain a failure",
      description:
        "Explain why tests of a run failed (default: the latest run, every test that didn't pass), from the run's evidence: the failing check (expected vs actual), the failing step, console errors, failed requests, the screenshot and trace. Every sentence cites evidence [E1]. Rules only by default (no AI); ai: true makes one model call. Never changes a verdict or cause.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    input: z
      .object({
        runId: RunId,
        test: z.string().optional().describe("A test id, file or name part."),
        ai: z.boolean().optional().describe("Let the AI write the diagnosis (one model call)."),
      })
      .strict(),
    output: () =>
      jsonSchema(
        z.object({
          runDir: z.string(),
          runId: z.string(),
          message: z.string().optional(),
          explanations: z.array(
            z
              .object({
                testId: z.string(),
                file: z.string(),
                verdict: z.string(),
                cause: z.string().nullable(),
                headline: z.string().nullable(),
                diagnosis: z.string(),
                next: z.array(z.string()),
                evidence: z.array(
                  z.object({
                    id: z.string(),
                    kind: z.string(),
                    text: z.string(),
                    path: z.string().optional(),
                  }),
                ),
                mode: z.enum(["rules", "ai"]),
              })
              .loose(),
          ),
        }),
      ),
    async run(args, ctx, signal) {
      const p = project(ctx);
      const dir = await runDirFor(p, args.runId);
      const core = await loadCore(ctx);
      let models: import("@optestra/models").Models | undefined;
      if (args.ai) {
        const m = await import("@optestra/models");
        const { dotenvSource, processEnvSource } = await import("@optestra/config/node");
        models = m.createModels({
          config: p.config,
          sources: [processEnvSource(ctx.env), dotenvSource(p.dir)],
          environment: ctx.environment,
          budgets: [m.BudgetMeter.forRun(p.config)],
          usageStore: m.projectUsageStore(p.dir),
          env: ctx.env,
        });
        if (!models.pool("planner").some((entry) => entry.usable))
          throw new ToolError(
            "No AI model is available for ai: true (no planner provider has a key). Call explain without ai for the rules-only explanation.",
          );
      }
      const result = await core.explainRun(dir, {
        ...(args.test ? { test: args.test } : {}),
        ...(models ? { models, maxCalls: 1 } : {}),
        signal,
      });
      return result as unknown as Record<string, unknown>;
    },
  }),

  tool({
    spec: {
      name: "list_heals",
      title: "List heals",
      description:
        "The heals of a run (default: the latest): steps the engine re-did because the UI changed, with the recording's before/after, why, and confidence. A heal only changes how a step is done, never a check.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    input: z.object({ runId: RunId }).strict(),
    output: () =>
      jsonSchema(
        z.object({
          runDir: z.string(),
          runId: z.string(),
          heals: z.array(HealSchema),
          rerecord: z.array(z.object({}).loose()),
        }),
      ),
    async run(args, ctx) {
      const p = project(ctx);
      const dir = await runDirFor(p, args.runId);
      const core = await loadCore(ctx);
      const listing = core.listHeals(dir);
      return listing as unknown as Record<string, unknown>;
    },
  }),

  tool({
    spec: {
      name: "accept_heal",
      title: "Accept heals",
      description:
        "Accept heals of a run (default: the latest) by id, or 'all'. Applies them to the recordings: only the healed steps' commands change; steps, Expect: lines and checks stay exactly as they are. Only heals of attempts that passed can be accepted.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    input: z
      .object({
        ids: z.array(z.string()).min(1).describe('Heal ids (or unique prefixes), or ["all"].'),
        runId: RunId,
      })
      .strict(),
    output: () =>
      jsonSchema(
        z.object({
          runDir: z.string(),
          accepted: z.array(HealSchema),
          skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
          recordings: z.array(z.string()),
          specs: z.array(z.string()),
          warnings: z.array(z.string()),
        }),
      ),
    async run(args, ctx) {
      const p = project(ctx);
      const dir = await runDirFor(p, args.runId);
      const core = await loadCore(ctx);
      const result = await core.applyHeals(
        p.dir,
        dir,
        args.ids.includes("all") ? "all" : args.ids,
        { reject: [], env: ctx.env, ...(ctx.environment ? { environment: ctx.environment } : {}) },
      );
      return {
        runDir: dir,
        accepted: result.accepted,
        skipped: result.skipped,
        recordings: result.recordings,
        specs: result.specs,
        warnings: result.warnings,
      } as unknown as Record<string, unknown>;
    },
  }),
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.spec.name);

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => ({
    ...t.spec,
    inputSchema: jsonSchema(t.input),
    outputSchema: t.output(),
  }));
}

const text = (value: unknown) => JSON.stringify(value, null, 2);

/** Runs a tool: validated input, structured output, errors as isError results. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  signal: AbortSignal,
): Promise<ToolResult> {
  const found = TOOLS.find((t) => t.spec.name === name);
  if (!found) return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  const parsed = found.input.safeParse(args);
  if (!parsed.success)
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Invalid arguments for ${name}: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`)
            .join("; ")}`,
        },
      ],
    };
  try {
    // biome-ignore lint/suspicious/noExplicitAny: each tool's input type is checked above.
    const structured = await found.run(parsed.data as any, ctx, signal);
    return { content: [{ type: "text", text: text(structured) }], structuredContent: structured };
  } catch (error) {
    const message =
      error instanceof ToolError
        ? error.message
        : `${name} failed: ${error instanceof Error ? `${error.message}${"fix" in error && typeof error.fix === "string" ? ` Fix: ${error.fix}` : ""}` : String(error)}`;
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

/** Whether a test has a recording (REP-8: on a feature branch, its own counts too). */
function isRecorded(
  dir: string,
  testsDir: string,
  config: Pick<Config, "recordings">,
  env: Readonly<Record<string, string | undefined>>,
  id: string,
): boolean {
  const branch = recordingBranch(config.recordings ?? { branches: "auto" }, env, dir);
  return existsSync(recordingFiles(join(dir, testsDir), id, branch).read);
}
