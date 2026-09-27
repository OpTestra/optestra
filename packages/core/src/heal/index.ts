export {
  FIXER_LIMITS,
  FIXER_PROMPT,
  FIXER_PROMPT_VERSION,
  type FixerMiss,
  fixerContext,
  runFixer,
} from "./fixer.js";
export {
  type ApplyResult,
  applyPatches,
  describeCommand,
  HEAL_PATCH_VERSION,
  type HealPatch,
  HealPatchSchema,
  patchDiff,
  relocatedCommand,
} from "./patch.js";
export { markAutoApplied } from "./policy.js";
