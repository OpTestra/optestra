import { ULID_PATTERN } from "./common.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID: 48-bit millisecond time + 80 random bits, Crockford base32. Sorts by
 * creation time. `random` is for tests and fixtures only.
 */
export function ulid(
  time: number = Date.now(),
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  if (!Number.isInteger(time) || time < 0 || time > 2 ** 48 - 1)
    throw new RangeError("ULID time must be a 48-bit integer");
  let timePart = "";
  for (let rest = time, i = 0; i < 10; i++) {
    timePart = ALPHABET[rest % 32] + timePart;
    rest = Math.floor(rest / 32);
  }
  let randomPart = "";
  for (const byte of random(new Uint8Array(16))) randomPart += ALPHABET[byte % 32];
  return timePart + randomPart;
}

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}
