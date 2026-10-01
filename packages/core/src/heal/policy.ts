import type { HealProposal } from "@optestra/contract";

// The fix policies (HEAL-5), per test (`heal:` in the frontmatter, else
// run.healPolicy):
//   strict  never heals: a miss fails the step (replay never looks for another element).
//   review  heals, the verdict is HEALED, proposals stay pending until a person accepts.
//   auto    heals and applies to the recording at once, still recorded as an
//           accepted proposal (appliedBy: auto). A behaviour change never is (HEAL-6).

/**
 * `auto`: marks a passed attempt's heals accepted (in place). A heal in an
 * attempt that failed hasn't proved itself and stays pending; so does a
 * heal classified `behavior_change`, which a person must check.
 */
export function markAutoApplied(
  heals: readonly HealProposal[],
  passed: boolean,
  now: () => Date = () => new Date(),
): void {
  if (!passed) return;
  const at = now().toISOString();
  for (const heal of heals) {
    if (heal.status !== "pending" || heal.classification === "behavior_change") continue;
    heal.status = "accepted";
    heal.appliedBy = "auto";
    heal.reviewedAt = at;
  }
}
