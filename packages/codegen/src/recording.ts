import {
  type CheckOp,
  CheckOpSchema,
  CheckRecordingSchema,
  type Recording,
  RecordingSchema,
} from "@testament/recording";
import { z } from "zod";

// The generator reads recordings leniently in one place: the check ops. New
// op types (LOOP-2's `soft_judgment`, later ones) and new `generatedBy` values
// must not stop a spec from being generated; the spec notes such a check as
// "checked by the test runner only" instead of failing on it.

/** A check op the spec knows, or any other op kept as-is. */
export type AnyCheckOp = CheckOp | { type: string; [field: string]: unknown };

export interface CodegenCheck {
  key: string;
  textKey: string;
  text: string;
  soft: boolean;
  check: AnyCheckOp;
  generatedBy: string;
}

export type CodegenRecording = Omit<Recording, "checks"> & { checks: CodegenCheck[] };

// Built from the fields, without the recording schema's refinements: this reader
// accepts ops it doesn't know, and they only ever become annotations, never code.
const LenientCheckSchema = z.object({
  ...CheckRecordingSchema.shape,
  check: z.looseObject({ type: z.string() }),
  generatedBy: z.string(),
});

const LenientRecordingSchema = z.object({
  ...RecordingSchema.shape,
  checks: z.array(LenientCheckSchema),
});

export type ParsedCodegenRecording =
  | { ok: true; recording: CodegenRecording }
  | { ok: false; error: string };

/** Keeps a known op typed; an op that doesn't validate stays opaque (and is never run as code). */
function checkOp(raw: { type: string; [field: string]: unknown }): AnyCheckOp {
  const known = CheckOpSchema.safeParse(raw);
  if (known.success) return known.data;
  return { ...raw, type: KNOWN.has(raw.type) ? `invalid:${raw.type}` : raw.type };
}

const KNOWN = new Set<string>(CheckOpSchema.options.map((option) => option.shape.type.value));

/** Parses recording JSON (text or value) for code generation. Never throws. */
export function readCodegenRecording(input: string | unknown): ParsedCodegenRecording {
  let json: unknown = input;
  if (typeof input === "string") {
    try {
      json = JSON.parse(input);
    } catch (error) {
      return {
        ok: false,
        error: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const result = LenientRecordingSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
    };
  }
  const { checks, ...rest } = result.data;
  return {
    ok: true,
    recording: {
      ...rest,
      checks: checks.map((check) => ({
        key: check.key,
        textKey: check.textKey,
        text: check.text,
        soft: check.soft,
        check: checkOp(check.check),
        generatedBy: check.generatedBy,
      })),
    },
  };
}
