import type { CheckEvaluation, PageCopy } from "@testament/browser";
import type { CheckOp, Sanity } from "@testament/recording";
import type { CheckSession } from "./evaluate.js";

// The check sanity test (VER-6): a check must be able to fail. It runs once
// more on two pages where it should NOT hold:
//
// 1. an empty page (about:blank, in a throwaway offline page of the session);
// 2. the page as it was before the preceding action: a static copy taken just
//    before that action ran (DOM with live field values, styles inlined, no
//    scripts), evaluated in the same throwaway page.
//
// The before-state only counts when the action changed what the check looks
// at: if the check's subject (its matched texts, URL, count or states) is the
// same before and after, the check verifies something the action was not
// meant to change (e.g. "the URL contains /checkout" after a declined card),
// and passing there says nothing. Absence checks (hidden, at most N) pass on
// an empty page by nature, so the empty page isn't used for them.

export interface SanityInput {
  op: CheckOp;
  values: Readonly<Record<string, string>>;
  /** The check's evaluation on the current page (its `seen` is compared). */
  now: CheckEvaluation;
  /** Copy of the page from just before the preceding action, if there was one. */
  before?: PageCopy | undefined;
}

const NO_SANITY = new Set(["soft_judgment", "code", "pending"]);

function isAbsence(op: CheckOp): boolean {
  if (op.type === "element_state") return op.state === "hidden" || op.state === "unchecked";
  if (op.type === "count") return op.n === 0 || (op.max !== undefined && op.min === undefined);
  return false;
}

export async function sanityTest(session: CheckSession, input: SanityInput): Promise<Sanity> {
  const { op } = input;
  if (NO_SANITY.has(op.type)) {
    const note =
      op.type === "soft_judgment"
        ? "Soft judgments are not sanity-tested (they can only warn)."
        : "Not evaluated in the harness.";
    return {
      empty: { result: "skipped", note },
      before: { result: "skipped", note },
      provesNothing: false,
    };
  }
  const probe = async (on: "blank" | PageCopy) =>
    session.check(op, { on, timeoutMs: 0, values: input.values });

  let empty: Sanity["empty"];
  if (isAbsence(op)) {
    empty = { result: "skipped", note: "An absence check holds on an empty page by nature." };
  } else {
    const result = await probe("blank");
    empty =
      result.status === "passed"
        ? { result: "passed", note: "It passes on an empty page." }
        : result.status === "failed"
          ? { result: "failed" }
          : { result: "skipped", note: result.message ?? result.status };
  }

  let before: Sanity["before"];
  if (!input.before) {
    before = { result: "skipped", note: "No action before this check." };
  } else {
    const result = await probe(input.before);
    if (result.status === "passed") {
      before =
        result.seen === input.now.seen
          ? {
              result: "skipped",
              note: "The preceding action didn't change what this check looks at.",
            }
          : { result: "passed", note: "It already passed before the preceding action." };
    } else if (result.status === "failed") {
      before = { result: "failed" };
    } else {
      before = { result: "skipped", note: result.message ?? result.status };
    }
  }
  return { empty, before, provesNothing: empty.result === "passed" || before.result === "passed" };
}
