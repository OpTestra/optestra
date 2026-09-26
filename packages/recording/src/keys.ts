import { hash16 } from "@testament/spec";

/**
 * Bumped ONLY when replay semantics change (what a command means, how keys are
 * built). Not the package version: upgrading must not throw recordings away.
 */
export const RECORDING_EPOCH = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const NUMBER = /^\d+$/;

/**
 * The page a step began on, normalized (REP-7): the path only (no host, query or
 * hash), numeric and UUID-like segments replaced by `:id`, no trailing slash.
 * Non-http pages keep their scheme (`about:blank`).
 */
export function routeOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://route.invalid");
  } catch {
    return url;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `${parsed.protocol}${parsed.pathname}`;
  }
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) =>
      NUMBER.test(segment) || UUID.test(segment) || ULID.test(segment) || LONG_HEX.test(segment)
        ? ":id"
        : segment,
    );
  return `/${segments.join("/")}`;
}

/** The contract's StepResult.key: hash of the step's textKey, its route and the epoch. */
export function stepKey(textKey: string, route: string, epoch: number = RECORDING_EPOCH): string {
  return hash16(JSON.stringify(["s1", textKey, route, epoch]));
}

/** Key of a check: checks don't depend on the route they were written for. */
export function checkKey(textKey: string, epoch: number = RECORDING_EPOCH): string {
  return hash16(JSON.stringify(["c1", textKey, epoch]));
}
