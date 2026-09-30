/**
 * Testament Bench (BEN-1…BEN-3, LRN-10, MOD-9): scoring the engine on the
 * fixtures in the repository's bench/ folder. Node only. Bench reads results;
 * it never changes a verdict.
 */
export {
  androidFixture,
  BenchSetupError,
  benchDir,
  emailTests,
  MAILPIT_URL,
  mailpitRunning,
  projectCopy,
  rowsOf,
  runShopVariant,
  type ShopFixture,
  type SpecRun,
  shopFixture,
  specShop,
} from "./fixtures.js";
export { type GateInput, type GateResult, evalGate } from "./gate.js";
export {
  type FixtureMetrics,
  fixtureMetrics,
  isFalseFail,
  isFalsePass,
  PASS_LIKE,
  type Rate,
  totalMetrics,
} from "./metrics.js";
export {
  type BaselineComparison,
  BENCH_REPORT_VERSION,
  type BenchReport,
  buildReport,
  compareToBaseline,
  type DecisionEvalSummary,
  type Delta,
  type FirstRun,
  type FixtureReport,
  type MeasuredWith,
  percent,
} from "./report.js";
export {
  type BenchOptions,
  EQUIVALENCE_VARIANTS,
  engineCommit,
  type FixtureChoice,
  latestFirstRun,
  runBench,
} from "./run.js";
export {
  type BenchRow,
  type Expectation,
  expectation,
  type FixtureId,
  type Manifest,
  type Score,
  scoreResult,
  stepStats,
} from "./score.js";
export { formatBench } from "./format.js";
export {
  entryId,
  estimateCalls,
  type ModelEntry,
  type ModelEvalFile,
  type ModelEvalOptions,
  type ModelEvalResult,
  parseModelEntry,
  ROUTER_PROVIDERS,
  runModelEval,
  saveModelEval,
} from "./models.js";
