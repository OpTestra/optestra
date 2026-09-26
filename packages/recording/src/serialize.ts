import { type Recording, RecordingSchema } from "./schema.js";

/**
 * Stable text for a recording: validated, keys in schema order, 2-space JSON,
 * one line per field, trailing newline. The same recording always gives the
 * same bytes, so git diffs show only real changes.
 */
export function serializeRecording(recording: Recording): string {
  return `${JSON.stringify(RecordingSchema.parse(recording), null, 2)}\n`;
}

export type ParsedRecording = { ok: true; recording: Recording } | { ok: false; error: string };

/** Parses recording text. Never throws. */
export function parseRecording(text: string): ParsedRecording {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = RecordingSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
    };
  }
  return { ok: true, recording: result.data };
}
