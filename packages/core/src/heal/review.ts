import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { brand } from "@optestra/brand";
import { loadProject } from "@optestra/config/node";
import {
  type HealDecision,
  type HealProposal,
  type HealReview,
  needsRerecord,
  runLayout,
  type TestResult,
  withHealReview,
} from "@optestra/contract";
import { readHealReview, readRun, writeHealReview } from "@optestra/contract/node";
import { healClass, missAction, sameElement } from "@optestra/decide";
import { createLabelStore } from "@optestra/decide/node";
import { readRecording, recordingPath, writeRecording } from "@optestra/recording/node";
import { applyPatches, describeCommand, type HealPatch, HealPatchSchema } from "./patch.js";

// Review and accept (HEAL-4). A run's heals are proposals; a person (or an
// agent, or the apps) lists them with the diff and the why (HEAL-6), then
// accepts or rejects them. Accepting applies the heal's patch to the recording
// (only that step's commands; keys and checks never change), regenerates the
// portable spec, records the decision in the run folder and writes labels
// (LRN-9). Nothing is committed to git.

export type HealLevel = "fallback" | "refind" | "fixer";

export interface HealItem {
  id: string;
  runId: string;
  testId: string;
  /** The test's name. */
  test: string;
  /** Project-relative test file. */
  file: string;
  attempt: number;
  stepIndex: number;
  /** The step line. */
  step: string;
  level: HealLevel | null;
  status: HealProposal["status"];
  classification: HealProposal["classification"];
  /** HEAL-6: never applied automatically; check before accepting. */
  behaviourChange: boolean;
  confidence: number;
  signals: HealProposal["signals"];
  changes: HealProposal["changes"];
  /** The recording diff, as text. */
  diff: string;
  /** The step's commands before and after, one line each. */
  before: string[];
  after: string[];
  /** Why the engine thinks this is right (HEAL-6), in plain lines. */
  why: string[];
  policy: HealProposal["policy"];
  appliedBy: HealProposal["appliedBy"] | null;
  reviewedAt: string | null;
  /** The attempt passed, so the heal proved itself (VER-5 and every later check). */
  proven: boolean;
  /** Can be accepted now; else `problem` says why not. */
  acceptable: boolean;
  problem: string | null;
}

export interface RerecordFlag {
  testId: string;
  file: string;
  healed: number;
  runs: number;
  command: string;
}

export interface HealListing {
  runDir: string;
  runId: string;
  heals: HealItem[];
  /** HEAL-7: tests that keep healing. */
  rerecord: RerecordFlag[];
}

export const BEHAVIOUR_WARNING = "the app's behaviour may have changed — check before accepting";

const LEVEL_WORDS: Record<HealLevel, string> = {
  fallback: "a stored fallback locator found the same element (no AI)",
  refind: "re-found from the recorded fingerprint (no AI)",
  fixer: "redone by the fixer model (AI)",
};

function why(heal: HealProposal, level: HealLevel | null): string[] {
  const lines: string[] = [];
  if (level) lines.push(`How: ${LEVEL_WORDS[level]}.`);
  lines.push(
    heal.classification === "cosmetic"
      ? "Cosmetic: the same control, restyled, moved or reworded; the step does the same thing."
      : heal.classification === "behavior_change"
        ? `Behaviour change: ${BEHAVIOUR_WARNING}.`
        : "Not classified: check the diff before accepting.",
  );
  lines.push(`Confidence ${Math.round(heal.confidence * 100)}%.`);
  for (const signal of [...heal.signals].sort((a, b) => b.score - a.score))
    lines.push(
      `${signal.name} ${signal.score.toFixed(2)}${signal.detail ? `: ${signal.detail}` : ""}`,
    );
  return lines;
}

function readPatch(runDir: string, testId: string, attempt: number, id: string): HealPatch | null {
  const file = join(runDir, runLayout.healPatch(testId, attempt, id));
  if (!existsSync(file)) return null;
  try {
    const parsed = HealPatchSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function itemsOf(runDir: string, runId: string, test: TestResult): HealItem[] {
  const items: HealItem[] = [];
  for (const attempt of test.attempts) {
    for (const heal of attempt.heals) {
      const patch = readPatch(runDir, test.testId, attempt.attempt, heal.id);
      const level = heal.level ?? patch?.level ?? null;
      const proven = attempt.status === "passed";
      const step = attempt.steps.find((s) => s.index === heal.stepIndex);
      const problem =
        heal.status !== "pending"
          ? `already ${heal.status}${heal.appliedBy === "auto" ? " (heal policy auto)" : ""}`
          : !proven
            ? "not proven: the attempt with this heal failed"
            : !patch
              ? "the run folder has no patch for this heal"
              : null;
      items.push({
        id: heal.id,
        runId,
        testId: test.testId,
        test: test.name,
        file: test.file,
        attempt: attempt.attempt,
        stepIndex: heal.stepIndex,
        step: step?.text ?? "",
        level,
        status: heal.status,
        classification: heal.classification,
        behaviourChange: heal.classification === "behavior_change",
        confidence: heal.confidence,
        signals: heal.signals,
        changes: heal.changes,
        diff: heal.diff,
        before: patch?.before.map(describeCommand) ?? [],
        after: patch?.after.map(describeCommand) ?? [],
        why: why(heal, level),
        policy: heal.policy,
        appliedBy: heal.appliedBy ?? null,
        reviewedAt: heal.reviewedAt ?? null,
        proven,
        acceptable: problem === null,
        problem,
      });
    }
  }
  return items;
}

/** Every heal of a run (pending first), with its diff, its why and whether it can be accepted. */
export function listHeals(runDir: string): HealListing {
  const dir = resolve(runDir);
  const { run, tests } = readRun(dir);
  if (!run) throw new Error(`${runDir} is not a finished run folder (no run.json).`);
  const review = readHealReview(dir);
  const heals: HealItem[] = [];
  const rerecord: RerecordFlag[] = [];
  for (const raw of tests) {
    const test = withHealReview(raw, review);
    heals.push(...itemsOf(dir, run.runId, test));
    if (test.recentHeals && needsRerecord(test.recentHeals))
      rerecord.push({
        testId: test.testId,
        file: test.file,
        healed: test.recentHeals.healed,
        runs: test.recentHeals.runs,
        command: `${brand.cliName} run ${test.file} --rerecord`,
      });
  }
  const order = { pending: 0, accepted: 1, rejected: 2 } as const;
  heals.sort((a, b) => order[a.status] - order[b.status]);
  return { runDir: dir, runId: run.runId, heals, rerecord };
}

export interface ApplyHealsOptions {
  /** Heal ids (or unique prefixes) to reject. */
  reject?: readonly string[];
  /** Regenerate the portable spec after accepting (default true). */
  generateSpecs?: boolean;
  environment?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Write labels for the decisions (default true). */
  labels?: boolean;
  now?: () => Date;
}

export interface ApplyHealsResult {
  accepted: HealItem[];
  rejected: HealItem[];
  /** Asked for, but not applied, with the reason. */
  skipped: { id: string; reason: string }[];
  /** Project-relative recordings changed. */
  recordings: string[];
  /** Project-relative specs regenerated. */
  specs: string[];
  warnings: string[];
  /** Labels written (LRN-9). */
  labels: number;
}

const posix = (path: string) => path.split(sep).join("/");

/** Resolves ids or unique prefixes against the listing. */
function pick(
  heals: readonly HealItem[],
  wanted: readonly string[],
  skipped: ApplyHealsResult["skipped"],
): HealItem[] {
  const out: HealItem[] = [];
  for (const id of wanted) {
    const matches = heals.filter((h) => h.id === id || h.id.startsWith(id));
    const exact = matches.find((h) => h.id === id);
    if (exact || matches.length === 1) {
      const item = exact ?? (matches[0] as HealItem);
      if (!out.includes(item)) out.push(item);
    } else
      skipped.push({
        id,
        reason: matches.length === 0 ? "no heal with this id in the run" : "ambiguous id prefix",
      });
  }
  return out;
}

/**
 * Accepts heals (`"all"`: every acceptable one; a behaviour change is accepted
 * with a warning) and rejects `options.reject`.
 */
export async function applyHeals(
  projectDir: string,
  runDir: string,
  ids: readonly string[] | "all",
  options: ApplyHealsOptions = {},
): Promise<ApplyHealsResult> {
  const project = resolve(projectDir);
  const dir = resolve(runDir);
  const now = options.now ?? (() => new Date());
  const listing = listHeals(dir);
  const result: ApplyHealsResult = {
    accepted: [],
    rejected: [],
    skipped: [],
    recordings: [],
    specs: [],
    warnings: [],
    labels: 0,
  };
  const toReject = pick(listing.heals, options.reject ?? [], result.skipped);
  let toAccept: HealItem[];
  if (ids === "all") toAccept = listing.heals.filter((h) => h.acceptable && !toReject.includes(h));
  else toAccept = pick(listing.heals, ids, result.skipped).filter((h) => !toReject.includes(h));
  // HEAL-6: a person may accept a behaviour change (only `auto` never does), but never unawares.
  for (const heal of toAccept.filter((h) => h.acceptable && h.behaviourChange))
    result.warnings.push(
      `${heal.id} (${heal.file} step ${heal.stepIndex + 1}): ${BEHAVIOUR_WARNING}; accepted as asked.`,
    );
  for (const heal of toAccept)
    if (!heal.acceptable)
      result.skipped.push({ id: heal.id, reason: heal.problem ?? "not acceptable" });
  toAccept = toAccept.filter((h) => h.acceptable);
  // A pending heal can always be rejected (proven or not); a decided one can't be decided again.
  const rejecting = toReject.filter((h) => h.status === "pending");
  for (const heal of toReject)
    if (heal.status !== "pending")
      result.skipped.push({ id: heal.id, reason: heal.problem ?? `already ${heal.status}` });

  const loaded = loadProject(project, {
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const testsDir = resolve(project, loaded.config.tests?.dir ?? "tests");
  const reviewedAt = now().toISOString();
  const decisions: HealDecision[] = [];
  const patches = new Map<string, HealPatch>();
  for (const heal of [...toAccept, ...rejecting]) {
    const patch = readPatch(dir, heal.testId, heal.attempt, heal.id);
    if (patch) patches.set(heal.id, patch);
  }

  // ── accept: apply each test's patches to its recording, then its spec ────────
  const byTest = new Map<string, HealItem[]>();
  for (const heal of toAccept) byTest.set(heal.testId, [...(byTest.get(heal.testId) ?? []), heal]);
  for (const [testId, heals] of byTest) {
    const file = recordingPath(testsDir, testId);
    const stored = readRecording(file);
    const recordingRel = posix(relative(project, file));
    if (!stored?.ok) {
      for (const heal of heals)
        result.skipped.push({ id: heal.id, reason: `${recordingRel} can't be read` });
      continue;
    }
    const patched = applyPatches(
      stored.recording,
      heals.map((h) => patches.get(h.id) as HealPatch),
    );
    for (const conflict of patched.conflicts)
      result.skipped.push({ id: conflict.healId, reason: conflict.reason });
    if (patched.applied.length === 0) continue;
    // HEAL-3: a heal never touches a check. (applyPatches can't, but never write one that did.)
    if (JSON.stringify(patched.recording.checks) !== JSON.stringify(stored.recording.checks))
      throw new Error("refusing to write a heal that changes a check");
    writeRecording(file, { ...patched.recording, updatedAt: reviewedAt });
    result.recordings.push(recordingRel);
    const specs: string[] = [];
    const warnings: string[] = [];
    const testPath = patches.get(patched.applied[0] as string)?.testPath ?? heals[0]?.file ?? "";
    if (options.generateSpecs ?? true) {
      try {
        const { generateAfterRecording } = await import("@optestra/codegen/node");
        const generated = await generateAfterRecording(project, testPath, {
          ...(options.environment ? { environment: options.environment } : {}),
          ...(options.env ? { env: options.env } : {}),
        });
        for (const f of generated.files) {
          if (f.status === "edited")
            warnings.push(`${f.path} was changed by hand: not regenerated (use generate --force).`);
          else if (f.status !== "unchanged") specs.push(f.path);
        }
        warnings.push(...generated.problems);
      } catch (error) {
        warnings.push(
          `The portable spec could not be regenerated: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    result.specs.push(...specs);
    result.warnings.push(...warnings);
    for (const heal of heals) {
      if (!patched.applied.includes(heal.id)) continue;
      result.accepted.push({ ...heal, status: "accepted", appliedBy: "human", reviewedAt });
      decisions.push({
        healId: heal.id,
        testId,
        status: "accepted",
        reviewedAt,
        appliedBy: "human",
        recording: recordingRel,
        specs,
        warnings,
      });
    }
  }

  // ── reject: the recording stays as it is ─────────────────────────────────────
  for (const heal of rejecting) {
    result.rejected.push({ ...heal, status: "rejected", reviewedAt });
    decisions.push({
      healId: heal.id,
      testId: heal.testId,
      status: "rejected",
      reviewedAt,
      recording: null,
      specs: [],
      warnings: [],
    });
  }

  if (decisions.length > 0) {
    const previous: HealReview = readHealReview(dir) ?? { runId: listing.runId, decisions: [] };
    const decided = new Set(decisions.map((d) => d.healId));
    writeHealReview(dir, {
      runId: listing.runId,
      decisions: [...previous.decisions.filter((d) => !decided.has(d.healId)), ...decisions],
    });
  }

  // ── labels (LRN-9): what a person said about the decisions behind each heal ──
  if (options.labels ?? true) {
    const store = createLabelStore(project);
    const label = (fn: () => void) => {
      try {
        fn();
        result.labels++;
      } catch (error) {
        result.warnings.push(
          `A label could not be written: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    for (const heal of result.accepted) {
      const labels = patches.get(heal.id)?.labels;
      if (!labels) continue;
      if (labels.sameElement !== undefined)
        label(() =>
          store.recordLabel(
            sameElement,
            labels.sameElement as never,
            { same: true },
            {
              source: "approved",
            },
          ),
        );
      const action = labels.action;
      if (labels.missAction !== undefined && action)
        label(() =>
          store.recordLabel(
            missAction,
            labels.missAction as never,
            { action },
            {
              source: "confirmed",
            },
          ),
        );
      if (labels.healClass !== undefined)
        label(() =>
          store.recordLabel(
            healClass,
            labels.healClass as never,
            {
              classification:
                heal.classification === "behavior_change" ? "behavior_change" : "cosmetic",
            },
            { source: "approved" },
          ),
        );
    }
    for (const heal of result.rejected) {
      const labels = patches.get(heal.id)?.labels;
      if (!labels) continue;
      if (labels.sameElement !== undefined)
        label(() =>
          store.recordLabel(
            sameElement,
            labels.sameElement as never,
            { same: false },
            {
              source: "rejected",
            },
          ),
        );
      if (labels.healClass !== undefined)
        label(() =>
          store.recordLabel(
            healClass,
            labels.healClass as never,
            { classification: "behavior_change" },
            { source: "rejected" },
          ),
        );
    }
  }
  return result;
}
