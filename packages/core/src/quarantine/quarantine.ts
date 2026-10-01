import { brand } from "@optestra/brand";
import type { Mute } from "@optestra/contract";
import type { QuarantineEntry } from "@optestra/spec";

// Quarantine (DIA-5). A mute is a project-file entry { test, reason, until }.
// While it lasts the test runs as usual (evidence and all) and keeps its real
// verdict, but its failure doesn't fail the run, the Action or alert; reports
// show it apart, as muted. The day after `until` it counts again, and the run
// says so. Nothing mutes a test by itself: a flaky test only gets a suggestion.

/** The longest a mute may last from today: a mute is a reminder, not a delete. */
export const MAX_MUTE_DAYS = 90;

const DAY = 86_400_000;

/** Today's date, YYYY-MM-DD, in UTC. */
export function todayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The mute entry of a test (by its file or its id), if any. */
export function quarantineEntry(
  entries: readonly QuarantineEntry[],
  test: { path: string; id: string },
): QuarantineEntry | undefined {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//, "");
  return entries.find((e) => normalize(e.test) === test.path || e.test === test.id);
}

/** Whether a test is muted today: muted until its date, then expired. */
export function muteState(
  entries: readonly QuarantineEntry[],
  test: { path: string; id: string },
  now: Date,
): { muted?: Mute; expired?: Mute } {
  const entry = quarantineEntry(entries, test);
  if (!entry) return {};
  const mute: Mute = { reason: entry.reason, until: entry.until, source: brand.configFileName };
  return entry.until >= todayOf(now) ? { muted: mute } : { expired: mute };
}

/** "2026-10-15", or a span from today: "14d", "2w". */
export function parseUntil(value: string, now: Date): string | undefined {
  const span = /^(\d+)\s*(d|w)$/i.exec(value.trim());
  if (span) {
    const days = Number(span[1]) * (span[2]?.toLowerCase() === "w" ? 7 : 1);
    return todayOf(new Date(now.getTime() + days * DAY));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return undefined;
  const date = new Date(`${value.trim()}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || todayOf(date) !== value.trim() ? undefined : value.trim();
}

export type MuteChange =
  | { ok: true; entries: QuarantineEntry[]; entry: QuarantineEntry; renewed: boolean }
  | { ok: false; message: string };

/**
 * The quarantine list with `test` muted until `until`. An existing mute (still
 * running, or expired) is only changed with `renew`: renewing is a decision.
 */
export function withMute(
  entries: readonly QuarantineEntry[],
  test: { path: string; id: string },
  input: { reason: string; until: string; renew?: boolean },
  now: Date,
): MuteChange {
  const reason = input.reason.trim();
  if (!reason)
    return { ok: false, message: "A mute needs a reason (--reason), e.g. an issue link." };
  const until = parseUntil(input.until, now);
  if (!until)
    return {
      ok: false,
      message: `"${input.until}" is not a date (YYYY-MM-DD) or a span like 14d.`,
    };
  const today = todayOf(now);
  if (until < today) return { ok: false, message: `${until} is in the past.` };
  const latest = todayOf(new Date(now.getTime() + MAX_MUTE_DAYS * DAY));
  if (until > latest)
    return {
      ok: false,
      message: `A mute lasts at most ${MAX_MUTE_DAYS} days (until ${latest}). Renew it then if it's still needed.`,
    };
  const existing = quarantineEntry(entries, test);
  if (existing && !input.renew)
    return {
      ok: false,
      message: `${test.path} is already muted until ${existing.until}${existing.until < today ? " (expired)" : ""} ("${existing.reason}"). Renewing is a decision: pass --renew.`,
    };
  const entry: QuarantineEntry = { test: test.path, reason, until };
  return {
    ok: true,
    entries: [...entries.filter((e) => e !== existing), entry],
    entry,
    renewed: Boolean(existing),
  };
}

/** The list without `test`'s mute. */
export function withoutMute(
  entries: readonly QuarantineEntry[],
  test: { path: string; id: string },
): { entries: QuarantineEntry[]; removed: QuarantineEntry | undefined } {
  const existing = quarantineEntry(entries, test);
  return { entries: entries.filter((e) => e !== existing), removed: existing };
}

/**
 * DIA-5: whether to suggest muting a failed or flaky test, from the decide
 * layer's flaky_or_real (intermittent) answer. Only a suggestion: nothing is muted.
 */
export async function muteSuggestion(
  result: import("@optestra/contract").TestResult,
  decisions: Pick<import("@optestra/decide").Decisions, "decide">,
  history: readonly { verdict: string; signature: string | null }[],
): Promise<import("@optestra/contract").MuteSuggestion | undefined> {
  const { flakyInput } = await import("@optestra/decide");
  const input = flakyInput(result, {
    history: history.map((h) => ({
      verdict: h.verdict as "passed" | "healed" | "failed" | "flaky" | "blocked",
      signature: h.signature,
    })),
  });
  if (!input) return undefined;
  const answer = await decisions.decide("flaky_or_real", input, { testId: result.testId });
  if (answer.status !== "decided") return undefined;
  const intermittent = (answer.answers as { intermittent?: boolean }).intermittent;
  if (!intermittent) return undefined;
  const flips = history.filter((h) => h.verdict === "flaky" || h.verdict === "failed").length;
  return {
    reason:
      result.verdict === "flaky"
        ? `failed, then passed on a retry${flips ? ` (and failed or was flaky in ${flips} of its last ${history.length} runs)` : ""}`
        : `fails intermittently (${flips} of its last ${history.length} runs failed or were flaky)`,
    confidence: answer.confidence,
  };
}
