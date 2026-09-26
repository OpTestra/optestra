import type { AnyTask } from "../task.js";
import { pageIsError } from "./page-is-error.js";

export { type PageIsErrorInput, pageIsError, pageIsErrorInput } from "./page-is-error.js";

/** Tasks every `Decisions` instance knows. DEC-2 adds the six real decisions here. */
export const BUILT_IN_TASKS: readonly AnyTask[] = [pageIsError];

/** Name → task, for typed `decide("page_is_error", input)`. Add each built-in task here. */
export interface DecisionTasks {
  page_is_error: typeof pageIsError;
}
