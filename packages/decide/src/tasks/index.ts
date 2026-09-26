import type { AnyTask } from "../task.js";
import { duplicateOrNew } from "./duplicate-or-new.js";
import { failureCause } from "./failure-cause.js";
import { flakyOrReal } from "./flaky-or-real.js";
import { healClass } from "./heal-class.js";
import { pageIsError } from "./page-is-error.js";

export {
  type DuplicateOrNewInput,
  duplicateOrNew,
  duplicateOrNewInput,
  type FailureSignature,
  failureSignatureSchema,
  signatureKeys,
} from "./duplicate-or-new.js";
export {
  FAILURE_CAUSE_OPTIONS,
  type FailureCauseInput,
  failureCause,
  failureCauseInput,
  failureSignals,
} from "./failure-cause.js";
export {
  type FlakyOrRealInput,
  flakyOrReal,
  flakyOrRealInput,
  flakySignals,
} from "./flaky-or-real.js";
export {
  type ElementFacts,
  elementFactsSchema,
  factsFromLocator,
  HEAL_CLASSES,
  type HealClassInput,
  healClass,
  healClassInput,
  healSignals,
  looseName,
} from "./heal-class.js";
export { type PageIsErrorInput, pageIsError, pageIsErrorInput } from "./page-is-error.js";
export { normalizeText, SIGNALS } from "./shared.js";

/** Tasks every `Decisions` instance knows. DEC-3 adds same_element and miss_action. */
export const BUILT_IN_TASKS: readonly AnyTask[] = [
  pageIsError,
  failureCause,
  flakyOrReal,
  duplicateOrNew,
  healClass,
];

/** Name → task, for typed `decide("failure_cause", input)`. Add each built-in task here. */
export interface DecisionTasks {
  page_is_error: typeof pageIsError;
  failure_cause: typeof failureCause;
  flaky_or_real: typeof flakyOrReal;
  duplicate_or_new: typeof duplicateOrNew;
  heal_class: typeof healClass;
}
