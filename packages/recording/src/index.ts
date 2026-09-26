/**
 * The recording format (REP-1): per test, what was done for each step and the
 * typed checks. Browser-safe; `/node` reads and writes the files.
 */
export { type BoundCheck, bindCheck } from "./bind.js";
export { describeCheck, describeLocator } from "./describe.js";
export { checkKey, RECORDING_EPOCH, routeOf, stepKey } from "./keys.js";
export * from "./schema.js";
export { type ParsedRecording, parseRecording, serializeRecording } from "./serialize.js";
export {
  type ResolvedPart,
  type TemplateVariable,
  templateParts,
  templateRefs,
  toTemplate,
} from "./templates.js";
