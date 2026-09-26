/**
 * Browser-safe entry: the test file model, parser, flow expansion, step keys
 * and printer. No disk access: flows are read through a `FileReader` callback,
 * so the web app runs this against files stored in the cloud. Disk access lives
 * in `@testament/spec/node`. Importing this registers the `tests` config section.
 */
import "./section.js";

export {
  diagnostic,
  hasSpecErrors,
  SPEC_DIAGNOSTIC_CODES,
  type SpecDiagnostic,
  type SpecDiagnosticCode,
  sortDiagnostics,
} from "./diagnostics.js";
export { EXACT_OPS, opTemplates, parseExactOp, printExactOp, printLocator } from "./exact.js";
export {
  type BoundSegment,
  type BoundText,
  displayOf,
  type ExpandContext,
  type ExpandedStep,
  type ExpandedTest,
  expandTest,
  type FileReader,
  flowCandidates,
  mapReader,
  normalizePath,
  type OriginFrame,
} from "./expand.js";
export { FRONTMATTER_KEYS, formatDuration, parseDuration } from "./frontmatter.js";
export {
  BUILT_IN_GENERATORS,
  createRng,
  DEFAULT_EMAIL_DOMAIN,
  defaultGenerators,
  type Generator,
  type GeneratorOptions,
  GeneratorRegistry,
  type Rng,
} from "./generators.js";
export { globToRegExp, matchesAny, matchGlob } from "./glob.js";
export { hash16 } from "./hash.js";
export {
  KeyCounter,
  normalizeTemplate,
  normalizeText as normalizeKeyText,
  stepKeyText,
  TEXT_KEY_VERSION,
  textKey,
} from "./key.js";
export * from "./model.js";
export {
  declaredSecrets,
  normalizeText,
  type ParseOptions,
  type ParseResult,
  parseTest,
} from "./parse.js";
export { printFrontmatter, printStep, printTest, withoutSource } from "./print.js";
export { type TestsSettings, testsSchema } from "./section.js";
export { parseTemplate, template, templateRefs } from "./template.js";
