import { inspect } from "node:util";
import { defaultRedactor, type Redactor } from "./redactor.js";

// Values live here, not on the object, so no enumeration, spread, clone or
// inspection of a SecretValue can reach them.
const store = new WeakMap<SecretValue, string>();

/**
 * An opaque secret. Printing, logging, JSON-encoding or interpolating it gives
 * `[secret:NAME]`. The value is only reachable through `revealSecret` from
 * `@testament/config/reveal`.
 */
export class SecretValue {
  readonly name: string;
  /** Domains the value may be typed into. */
  readonly domains: readonly string[];
  /** Where the value came from, e.g. ".env.staging" or "environment variable". */
  readonly origin: string;

  private constructor(name: string, domains: readonly string[], origin: string) {
    this.name = name;
    this.domains = Object.freeze([...domains]);
    this.origin = origin;
    Object.freeze(this);
  }

  /** @internal Use `createSecretValue`. */
  static create(
    name: string,
    value: string,
    domains: readonly string[],
    origin: string,
  ): SecretValue {
    const secret = new SecretValue(name, domains, origin);
    store.set(secret, value);
    return secret;
  }

  get label(): string {
    return `[secret:${this.name}]`;
  }

  toString(): string {
    return this.label;
  }

  toJSON(): string {
    return this.label;
  }

  [Symbol.toPrimitive](): string {
    return this.label;
  }

  [inspect.custom](): string {
    return this.label;
  }
}

export interface CreateSecretOptions {
  domains?: readonly string[];
  origin?: string;
  redactor?: Redactor;
}

/** Wraps a raw value and registers it (and its common encodings) with the redactor. */
export function createSecretValue(
  name: string,
  value: string,
  options: CreateSecretOptions = {},
): SecretValue {
  (options.redactor ?? defaultRedactor).register(value, `[secret:${name}]`);
  return SecretValue.create(name, value, options.domains ?? [], options.origin ?? "unknown");
}

/** Same value, different allowed domains. */
export function withDomains(secret: SecretValue, domains: readonly string[]): SecretValue {
  return SecretValue.create(secret.name, readSecretValue(secret), domains, secret.origin);
}

/** @internal Only for `reveal.ts` and this package. */
export function readSecretValue(secret: SecretValue): string {
  const value = store.get(secret);
  if (value === undefined) throw new Error(`Not a loaded secret: ${String(secret)}`);
  return value;
}
