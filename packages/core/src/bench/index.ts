/**
 * Bench (BEN-1…BEN-3, LRN-10, MOD-9): scoring the engine on the
 * fixtures in the repository's bench/ folder. Node only. Bench reads results;
 * it never changes a verdict.
 */

export {
  add as addCallTotals,
  type CallTotals,
  type ComparisonFile,
  type ComparisonOptions,
  complexityOf,
  formatComparison,
  type ModelComparison,
  runComparison,
  saveComparison,
  summarize,
  totals as callTotals,
} from "./comparison.js";
export {
  analyzeCorpus,
  CORPUS_FIXTURES,
  CORPUS_VERSION,
  type CorpusEntry,
  type CorpusEstimate,
  type CorpusFile,
  type CorpusFixture,
  type CorpusOptions,
  type CorpusRoute,
  type CorpusStyle,
  type CorpusStyleResult,
  descriptionOf,
  type EntryLint,
  estimateCorpus,
  formatCorpus,
  formatEstimate,
  formatStatic,
  loadCorpus,
  loadStyles,
  runCorpus,
  type StaticStyleSummary,
  saveCorpus,
  selectEntries,
} from "./corpus.js";
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
export { formatBench } from "./format.js";
export { evalGate, type GateInput, type GateResult } from "./gate.js";
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
export {
  BASELINE_VERSION,
  billableSeconds,
  type CloudBaseline,
  type CloudFacts,
  type CloudPrices,
  type CostMeasurement,
  type CostPhase,
  type EvidenceMode,
  formatBaseline,
  loadCloudPrices,
  loadRawPrices,
  MEASUREMENT_KIND,
  MEASUREMENT_VERSION,
  type MeasuredTest,
  type MeterContext,
  meterReport,
  shapeRate,
  withCloudFacts,
} from "./cost.js";
export { cpuNow, peakMemory, runSlice, type Slice, type SliceOptions } from "./slice.js";
export {
  type AiPricing,
  type AndroidPath,
  assembleBaseline,
  type Complexity,
  type CostBaselineFile,
  formatCostBaseline,
  type IdleFacts,
  type StyleCost,
  type VmRun,
} from "./baseline.js";
