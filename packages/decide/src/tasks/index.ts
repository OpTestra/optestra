import type { AnyTask } from "../task.js";
import { duplicateOrNew } from "./duplicate-or-new.js";
import { failureCause } from "./failure-cause.js";
import { flakyOrReal } from "./flaky-or-real.js";
import { healClass } from "./heal-class.js";
import { missAction } from "./miss-action.js";
import { pageIsError } from "./page-is-error.js";
import { sameElement } from "./same-element.js";

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
export {
  blockedReasonFor,
  MISS_ACTIONS,
  type MissAction,
  type MissActionInput,
  missAction,
  missActionInput,
} from "./miss-action.js";
export { compareNames, type NameRelation } from "./names.js";
export { type PageIsErrorInput, pageIsError, pageIsErrorInput } from "./page-is-error.js";
export {
  type ElementIdentity,
  elementIdentitySchema,
  SAME_ELEMENT_SIGNALS,
  type SameElementInput,
  type ScoredSignal,
  sameElement,
  sameElementInput,
  scoreSameElement,
} from "./same-element.js";
export { normalizeText, SIGNALS } from "./shared.js";

/** Tasks every `Decisions` instance knows. */
export const BUILT_IN_TASKS: readonly AnyTask[] = [
  pageIsError,
  sameElement,
  missAction,
  failureCause,
  flakyOrReal,
  duplicateOrNew,
  healClass,
];

/** Name → task, for typed `decide("failure_cause", input)`. Add each built-in task here. */
export interface DecisionTasks {
  page_is_error: typeof pageIsError;
  same_element: typeof sameElement;
  miss_action: typeof missAction;
  failure_cause: typeof failureCause;
  flaky_or_real: typeof flakyOrReal;
  duplicate_or_new: typeof duplicateOrNew;
  heal_class: typeof healClass;
}
