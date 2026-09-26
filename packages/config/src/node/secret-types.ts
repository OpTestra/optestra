import type { Config } from "../schema.js";
import type { SecretProducer } from "./secret-value.js";

/** The result of checking a stored value against its secret type. */
export type SecretTypeCheck =
  | {
      ok: true;
      /** Parts of the value that must be redacted too (e.g. the seed inside an otpauth:// URI). */
      sensitive?: string[];
    }
  | { ok: false; problem: string; fix: string };

/**
 * A secret type other than plain `text`. The owning package registers it when it
 * loads (like a config section): `@testament/auth` registers `totp`.
 */
export interface SecretTypeDefinition {
  type: string;
  /** Checks a stored value. Never include the value in `problem`. */
  check(stored: string): SecretTypeCheck;
  /** The producer that makes the value to type at the moment of typing. */
  producer(context: { name: string; config: Config }): SecretProducer;
}

const types = new Map<string, SecretTypeDefinition>();

/** Registers a secret type. Registering the same definition again is a no-op. */
export function registerSecretType(definition: SecretTypeDefinition): void {
  const existing = types.get(definition.type);
  if (existing && existing !== definition) {
    throw new Error(`Secret type "${definition.type}" is already registered`);
  }
  types.set(definition.type, definition);
}

export function secretType(type: string): SecretTypeDefinition | undefined {
  return types.get(type);
}
