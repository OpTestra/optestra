import { readSecretValue, type SecretValue } from "./node/secret-value.js";

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
