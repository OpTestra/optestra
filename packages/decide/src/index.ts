/**
 * Browser-safe entry: the decision layer. Tasks, the rules → model → escalate
 * pipeline, racing, batching, the backend interface, metrics and an in-memory
 * cache. Disk stores (cache, labels) live in `@testament/decide/node`.
 * Importing this registers the `decisions` config section.
 */
import "./section.js";

export {
  type BackendAnswer,
  type BackendCallOptions,
  type BackendFailure,
  type BackendRequest,
  type BackendResponse,
  type DecisionBackend,
  type MockBackend,
  type MockBackendOptions,
  mockBackend,
  validAnswer,
} from "./backend.js";
export {
  type CachedDecision,
  cacheKey,
  canonicalJson,
  type DecisionCache,
  memoryCache,
} from "./cache.js";
export {
  type BatchItem,
  createDecisions,
  type Decided,
  type DecisionContext,
  type DecisionMeta,
  type DecisionResult,
  type Decisions,
  type DecisionsOptions,
  type EffectiveTaskSettings,
  type Escalated,
  type EscalationReason,
  type OnDecision,
  type RaceResult,
  type ScoredAnswer,
  taskSettings,
} from "./decide.js";
export { taskProblems, VERDICT_WORDS } from "./guard.js";
export {
  type DecisionMetrics,
  MetricsCollector,
  metricsFromRecords,
  type TaskMetrics,
} from "./metrics.js";
export {
  BACKEND_IDS,
  type BackendId,
  type DecisionsSettings,
  type DecisionTaskSettings,
  decisionsSchema,
} from "./section.js";
export {
  type AnswerValue,
  type Answers,
  type AnyTask,
  type ChoiceQuestion,
  DEFAULT_TIME_LIMIT_MS,
  type DecisionPhase,
  type DecisionTask,
  defineTask,
  type EscalateTo,
  type InputOf,
  type NoulQuestion,
  QUESTION_KINDS,
  type Question,
  type QuestionKind,
  type Questions,
  type QuestionsOf,
  type RulesAnswer,
  type ScoreQuestion,
  untrusted,
} from "./task.js";
export {
  BUILT_IN_TASKS,
  type DecisionTasks,
  type PageIsErrorInput,
  pageIsError,
  pageIsErrorInput,
} from "./tasks/index.js";
