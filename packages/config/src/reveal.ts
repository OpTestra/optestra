import { prepareSecretValue, readSecretValue, type SecretValue } from "./node/secret-value.js";

/**
 * Returns the raw value of a secret.
 *
 * RESTRICTED: only the browser and Android drivers may call this, at the moment
 * a value is typed into an allowed domain (from the AUTH phase on). Nothing else
 * (logging, reports, AI prompts, the apps) may import this module. Keep every
 * import of `@testament/config/reveal` easy to find in code review.
 */
export function revealSecret(secret: SecretValue): string {
  return readSecretValue(secret);
}

/**
 * Returns the value to type NOW. For a plain secret that is its value. For a
 * dynamic secret (a TOTP seed) it is produced at this moment, e.g. the current
 * code, after waiting for a fresh one if the current code is about to expire.
 * The produced value is registered with the redactor before this resolves.
 *
 * RESTRICTED like `revealSecret`: only the drivers call this, right before typing.
 * `revealSecret` of a dynamic secret gives the stored seed, never a code.
 */
export function prepareSecret(secret: SecretValue): Promise<string> {
  return prepareSecretValue(secret);
}
