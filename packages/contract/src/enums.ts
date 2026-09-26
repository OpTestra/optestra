import { z } from "zod";

const OPEN_VALUE = /^[a-z][a-z0-9_]*$/;

/**
 * An enum that may gain values within a contract version. Readers accept any
 * snake_case value, so documents from a newer minor version still parse.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(
  values: T,
): z.ZodType<T[number] | (string & {}), T[number] | (string & {})> {
  return z.union([z.enum(values), z.string().regex(OPEN_VALUE)]);
}

/** HEAL-2. Blocked is never counted as pass or fail. */
export const VERDICTS = ["passed", "healed", "failed", "flaky", "blocked"] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

/** DIA-1. */
export const FAILURE_CAUSES = [
  "product_bug",
  "test_drift",
  "environment",
  "test_data",
  "blocked",
] as const;
export const FailureCauseSchema = z.enum(FAILURE_CAUSES);
export type FailureCause = z.infer<typeof FailureCauseSchema>;

/** Why a test or run could not run. Open: may grow within a contract version. */
export const BLOCKED_REASONS = [
  "captcha",
  "missing_secret",
  "disallowed_domain",
  "ai_unavailable",
  "budget_exceeded",
  "app_down",
  "app_install_failed",
  "config_error",
  "aborted",
] as const;
export const BlockedReasonSchema = openEnum(BLOCKED_REASONS);
export type BlockedReason = z.infer<typeof BlockedReasonSchema>;

export const STEP_KINDS = ["action", "expect", "soft", "guard", "exact", "flow"] as const;
export const StepKindSchema = z.enum(STEP_KINDS);
export type StepKind = z.infer<typeof StepKindSchema>;

/**
 * HEAL-1: how a step got done. `replay` = the recording worked as-is,
 * `refind` = re-found from the fingerprint without AI, `fixer` = the AI redid
 * the step, `none` = no recorded action applied (checks, first recording, or
 * every level failed).
 */
export const RECOVERY_LEVELS = ["replay", "refind", "fixer", "none"] as const;
export const RecoveryLevelSchema = z.enum(RECOVERY_LEVELS);
export type RecoveryLevel = z.infer<typeof RecoveryLevelSchema>;

export const TRIGGERS = ["desktop", "web", "cloud", "ci", "cli", "agent", "schedule"] as const;
export const TriggerSchema = z.enum(TRIGGERS);
export type Trigger = z.infer<typeof TriggerSchema>;

export const TARGETS = ["web", "android"] as const;
export const TargetSchema = z.enum(TARGETS);
export type Target = z.infer<typeof TargetSchema>;

/** REP-6. */
export const RUN_MODES = ["replay-only", "normal", "rerecord"] as const;
export const RunModeSchema = z.enum(RUN_MODES);
export type RunMode = z.infer<typeof RunModeSchema>;

/** HEAL-5. */
export const HEAL_POLICIES = ["strict", "review", "auto"] as const;
export const HealPolicySchema = z.enum(HEAL_POLICIES);
export type HealPolicy = z.infer<typeof HealPolicySchema>;

export const STEP_STATUSES = ["passed", "failed", "warned", "skipped", "blocked"] as const;
export const StepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const ATTEMPT_STATUSES = ["passed", "failed", "blocked"] as const;
export const AttemptStatusSchema = z.enum(ATTEMPT_STATUSES);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

export const CHECK_KINDS = [
  "text",
  "url",
  "element_state",
  "count",
  "network",
  "aria_snapshot",
  "screen",
  "custom",
] as const;
export const CheckKindSchema = z.enum(CHECK_KINDS);
export type CheckKind = z.infer<typeof CheckKindSchema>;

export const ARTIFACT_KINDS = [
  "video",
  "trace",
  "screenshot",
  "console",
  "network",
  "logcat",
  "report",
  "other",
] as const;
export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
