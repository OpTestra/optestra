import { inspect } from "node:util";
import { defaultRedactor, type Redactor } from "./redactor.js";

// Values live here, not on the object, so no enumeration, spread, clone or
// inspection of a SecretValue can reach them.
const store = new WeakMap<SecretValue, string>();

/**
 * Makes the value to type from the stored value at the moment of typing, e.g. the
 * current TOTP code from a seed. May wait (for a fresh code); must not throw for
 * a value that passed its type's check.
 */
export type SecretProducer = (stored: string) => Promise<string>;

interface Dynamic {
  produce: SecretProducer;
  /** Every produced value is registered here before it is returned. */
  redactor: Redactor;
}
const dynamic = new WeakMap<SecretValue, Dynamic>();
// The redactor each secret was registered with, so produced values go there too.
const redactors = new WeakMap<SecretValue, Redactor>();

/**
 * An opaque secret. Printing, logging, JSON-encoding or interpolating it gives
 * `[secret:NAME]`. The value is only reachable through `revealSecret` from
 * `@optestra/config/reveal`.
 */
export class SecretValue {
  readonly name: string;
  /** Domains the value may be typed into. */
  readonly domains: readonly string[];
  /** Where the value came from, e.g. ".env.staging" or "environment variable". */
  readonly origin: string;
  /** How the value is typed: `text` as it is, `totp` as the current code from a seed. */
  readonly type: string;

  private constructor(name: string, domains: readonly string[], origin: string, type: string) {
    this.name = name;
    this.domains = Object.freeze([...domains]);
    this.origin = origin;
    this.type = type;
    Object.freeze(this);
  }

  /** @internal Use `createSecretValue`. */
  static create(
    name: string,
    value: string,
    domains: readonly string[],
    origin: string,
    type = "text",
  ): SecretValue {
    const secret = new SecretValue(name, domains, origin, type);
    store.set(secret, value);
    return secret;
  }

  /** True when the typed value is produced at the moment of typing (e.g. TOTP). */
  get dynamic(): boolean {
    return dynamic.has(this);
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
  const redactor = options.redactor ?? defaultRedactor;
  redactor.register(value, `[secret:${name}]`);
  const secret = SecretValue.create(
    name,
    value,
    options.domains ?? [],
    options.origin ?? "unknown",
  );
  redactors.set(secret, redactor);
  return secret;
}

/** Same value, different allowed domains. */
export function withDomains(secret: SecretValue, domains: readonly string[]): SecretValue {
  const copy = SecretValue.create(
    secret.name,
    readSecretValue(secret),
    domains,
    secret.origin,
    secret.type,
  );
  const entry = dynamic.get(secret);
  if (entry) dynamic.set(copy, entry);
  const redactor = redactors.get(secret);
  if (redactor) redactors.set(copy, redactor);
  return copy;
}

/**
 * Same stored value and domains, but typed through `produce` (e.g. TOTP). Every
 * produced value is registered with `redactor` (default: the one the secret was
 * created with, else `defaultRedactor`).
 */
export function asDynamicSecret(
  secret: SecretValue,
  type: string,
  produce: SecretProducer,
  redactor: Redactor = redactors.get(secret) ?? defaultRedactor,
): SecretValue {
  const copy = SecretValue.create(
    secret.name,
    readSecretValue(secret),
    secret.domains,
    secret.origin,
    type,
  );
  dynamic.set(copy, { produce, redactor });
  redactors.set(copy, redactor);
  return copy;
}

/**
 * @internal Only for `reveal.ts`. The value to type now: the stored value, or
 * for a dynamic secret the freshly produced one (already registered with the
 * redactor when this resolves).
 */
export async function prepareSecretValue(secret: SecretValue): Promise<string> {
  const stored = readSecretValue(secret);
  const entry = dynamic.get(secret);
  if (!entry) return stored;
  const value = await entry.produce(stored);
  entry.redactor.register(value, secret.label);
  return value;
}

/** Registers more values that must never be shown, with the secret's own redactor. */
export function registerSensitive(secret: SecretValue, values: readonly string[]): void {
  const redactor = redactors.get(secret) ?? defaultRedactor;
  for (const value of values) redactor.register(value, secret.label);
}

/** @internal Only for `reveal.ts` and this package. */
export function readSecretValue(secret: SecretValue): string {
  const value = store.get(secret);
  if (value === undefined) throw new Error(`Not a loaded secret: ${String(secret)}`);
  return value;
}
