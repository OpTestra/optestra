import { z } from "zod";
import { CheckResultSchema } from "./check.js";
import {
  ArtifactRefSchema,
  ContractVersionSchema,
  CountSchema,
  IdSchema,
  RunIdSchema,
  TimestampSchema,
} from "./common.js";
import {
  AttemptStatusSchema,
  FailureCauseSchema,
  RunModeSchema,
  StepKindSchema,
  TargetSchema,
  TriggerSchema,
  VerdictSchema,
} from "./enums.js";
import {
  AccessibilityReportSchema,
  MockUseSchema,
  MuteSchema,
  MuteSuggestionSchema,
} from "./extras.js";
import { HealProposalSchema } from "./heal.js";
import { DecisionRecordSchema, ModelCallSchema } from "./records.js";
import { GitInfoSchema, RunBlockSchema } from "./run.js";
import { StepResultSchema } from "./step.js";
import {
  AiUsageSchema,
  DeciderSchema,
  EvidenceRefSchema,
  MatrixEntrySchema,
  RecentHealsSchema,
} from "./test-result.js";

/**
 * Live events, one JSON object per line of events.ndjson. `seq` is strictly
 * increasing within a run. Folding the stream gives the final documents
 * (see foldEvents). New event types may be added within a contract version;
 * readers skip types they don't know.
 */
export const EVENT_TYPES = [
  "run.started",
  "test.started",
  "attempt.started",
  "step.started",
  "step.finished",
  "check.evaluated",
  "model.called",
  "decision.made",
  "heal.proposed",
  "artifact.written",
  "attempt.finished",
  "test.finished",
  "run.finished",
  "log",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const AttemptNumberSchema = z.number().int().min(1);
const base = { seq: CountSchema, ts: TimestampSchema, runId: RunIdSchema };
const inAttempt = { testId: IdSchema, attempt: AttemptNumberSchema };
/** Calls, decisions and artifacts may belong to an attempt or to the run as a whole. */
const maybeInAttempt = {
  testId: IdSchema.nullable().default(null),
  attempt: AttemptNumberSchema.nullable().default(null),
};

export const RunStartedEventSchema = z.object({
  ...base,
  type: z.literal("run.started"),
  contractVersion: ContractVersionSchema,
  engineVersion: z.string(),
  project: z.string(),
  environment: z.string().nullable(),
  target: TargetSchema,
  trigger: TriggerSchema,
  mode: RunModeSchema,
  git: GitInfoSchema.nullable().default(null),
});

export const TestStartedEventSchema = z.object({
  ...base,
  type: z.literal("test.started"),
  testId: IdSchema,
  file: z.string(),
  name: z.string(),
  tags: z.array(z.string()).default([]),
  matrix: MatrixEntrySchema,
});

export const AttemptStartedEventSchema = z.object({
  ...base,
  type: z.literal("attempt.started"),
  ...inAttempt,
});

/** Live view only: the step now running. Its result comes with step.finished. */
export const StepStartedEventSchema = z.object({
  ...base,
  type: z.literal("step.started"),
  ...inAttempt,
  index: CountSchema,
  key: z.string(),
  text: z.string(),
  kind: StepKindSchema,
});

export const StepFinishedEventSchema = z.object({
  ...base,
  type: z.literal("step.finished"),
  ...inAttempt,
  step: StepResultSchema,
});

export const CheckEvaluatedEventSchema = z.object({
  ...base,
  type: z.literal("check.evaluated"),
  ...inAttempt,
  check: CheckResultSchema,
});

export const ModelCalledEventSchema = z.object({
  ...base,
  type: z.literal("model.called"),
  ...maybeInAttempt,
  call: ModelCallSchema,
});

export const DecisionMadeEventSchema = z.object({
  ...base,
  type: z.literal("decision.made"),
  ...maybeInAttempt,
  decision: DecisionRecordSchema,
});

export const HealProposedEventSchema = z.object({
  ...base,
  type: z.literal("heal.proposed"),
  ...inAttempt,
  heal: HealProposalSchema,
});

export const ArtifactWrittenEventSchema = z.object({
  ...base,
  type: z.literal("artifact.written"),
  ...maybeInAttempt,
  artifact: ArtifactRefSchema,
});

export const AttemptFinishedEventSchema = z.object({
  ...base,
  type: z.literal("attempt.finished"),
  ...inAttempt,
  status: AttemptStatusSchema,
  /** 1.5 (ENV-4): mocked or recorded responses the attempt used. */
  mocks: z.array(MockUseSchema).optional(),
  /** 1.5 (EVD-6): accessibility warnings of the pages visited (when turned on). */
  accessibility: AccessibilityReportSchema.optional(),
});

export const TestFinishedEventSchema = z.object({
  ...base,
  type: z.literal("test.finished"),
  testId: IdSchema,
  verdict: VerdictSchema,
  decidedBy: z.array(DeciderSchema).min(1),
  failureCause: FailureCauseSchema.nullable().default(null),
  failureEvidence: z.array(EvidenceRefSchema).default([]),
  headline: z.string().nullable().default(null),
  checkedSummary: z.array(z.string()).default([]),
  recentAi: AiUsageSchema.shape.recent.default(null),
  /** 1.2 (HEAL-7). */
  recentHeals: RecentHealsSchema.optional(),
  /** 1.5 (DIA-5): the test was muted: its failure doesn't count. */
  muted: MuteSchema.optional(),
  /** 1.5 (DIA-5): its mute ended; it counts again. */
  muteExpired: MuteSchema.optional(),
  /** 1.5 (DIA-5): flaky: muting is suggested (never done automatically). */
  muteSuggested: MuteSuggestionSchema.optional(),
});

export const RunFinishedEventSchema = z.object({
  ...base,
  type: z.literal("run.finished"),
  blocked: RunBlockSchema.nullable().default(null),
});

export const LogEventSchema = z.object({
  ...base,
  type: z.literal("log"),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  testId: IdSchema.nullable().default(null),
});

export const EventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  TestStartedEventSchema,
  AttemptStartedEventSchema,
  StepStartedEventSchema,
  StepFinishedEventSchema,
  CheckEvaluatedEventSchema,
  ModelCalledEventSchema,
  DecisionMadeEventSchema,
  HealProposedEventSchema,
  ArtifactWrittenEventSchema,
  AttemptFinishedEventSchema,
  TestFinishedEventSchema,
  RunFinishedEventSchema,
  LogEventSchema,
]);
export type Event = z.infer<typeof EventSchema>;
/** What a producer passes in: defaults filled by the schema may be left out. */
export type EventInput = z.input<typeof EventSchema>;
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

export type ParsedEvent =
  | { kind: "event"; event: Event }
  | { kind: "unknown"; type: string; seq: number }
  | { kind: "invalid"; message: string };

const KNOWN = new Set<string>(EVENT_TYPES);
const UnknownEventSchema = z.object({ ...base, type: z.string() });

/** Parses one event. Types from a newer minor version come back as "unknown", not errors. */
export function parseEvent(value: unknown): ParsedEvent {
  const known = EventSchema.safeParse(value);
  if (known.success) return { kind: "event", event: known.data };
  const loose = UnknownEventSchema.safeParse(value);
  if (loose.success && !KNOWN.has(loose.data.type)) {
    return { kind: "unknown", type: loose.data.type, seq: loose.data.seq };
  }
  return { kind: "invalid", message: z.prettifyError(known.error) };
}
