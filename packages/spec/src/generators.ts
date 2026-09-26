import { fnv64 } from "./hash.js";

/**
 * Value generators behind `{{unique.*}}` and `{{faker.*}}` (AUT-4, ENV-3).
 * Deterministic: a value depends only on the run seed and where it is used, so
 * the same seed gives the same values and different seeds (runs, workers) give
 * different ones. No faker dependency: small built-in word lists.
 */

/** Deterministic random numbers for one generated value. */
export interface Rng {
  /** Integer in [0, max). */
  int(max: number): number;
  pick<T>(items: readonly T[]): T;
  /** `length` characters of [0-9a-z]. */
  token(length: number): string;
}

export interface GeneratorOptions {
  /** Domain for `unique.email`. Default `example.test`. */
  emailDomain: string;
}

export type Generator = (rng: Rng, options: GeneratorOptions) => string;

/** splitmix64, seeded from FNV-1a of the key. */
export function createRng(key: string): Rng {
  let state = fnv64(key);
  const next = (): bigint => {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return z ^ (z >> 31n);
  };
  const int = (max: number) => Number(next() % BigInt(max));
  return {
    int,
    pick: <T>(items: readonly T[]) => items[int(items.length)] as T,
    token: (length) => {
      let out = "";
      for (let i = 0; i < length; i++) out += "0123456789abcdefghijklmnopqrstuvwxyz"[int(36)];
      return out;
    },
  };
}

const FIRST = [
  "Ada",
  "Alan",
  "Grace",
  "Linus",
  "Margaret",
  "Dennis",
  "Barbara",
  "Ken",
  "Frances",
  "Tim",
  "Hedy",
  "Edsger",
  "Radia",
  "Donald",
  "Katherine",
  "John",
  "Joan",
  "Niklaus",
  "Sophie",
  "Vint",
] as const;
const LAST = [
  "Lovelace",
  "Turing",
  "Hopper",
  "Torvalds",
  "Hamilton",
  "Ritchie",
  "Liskov",
  "Thompson",
  "Allen",
  "Berners",
  "Lamarr",
  "Dijkstra",
  "Perlman",
  "Knuth",
  "Johnson",
  "Backus",
  "Clarke",
  "Wirth",
  "Wilson",
  "Cerf",
] as const;
const COMPANY_WORDS = [
  "Northwind",
  "Bluebird",
  "Granite",
  "Lumen",
  "Harbor",
  "Juniper",
  "Copper",
  "Meadow",
  "Summit",
  "Orbit",
] as const;
const COMPANY_SUFFIXES = ["Labs", "Works", "Group", "Studio", "Systems", "Co"] as const;
const CITIES = [
  "Lisbon",
  "Nairobi",
  "Osaka",
  "Toronto",
  "Lagos",
  "Melbourne",
  "Bogotá",
  "Oslo",
  "Pune",
  "Tallinn",
] as const;

const lower = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Built-in generators, keyed `namespace.member`. */
export const BUILT_IN_GENERATORS: Readonly<Record<string, Generator>> = {
  "unique.email": (rng, { emailDomain }) => `test-${rng.token(10)}@${emailDomain}`,
  "unique.id": (rng) => rng.token(12),
  "unique.name": (rng) => `${rng.pick(FIRST)} ${rng.pick(LAST)} ${rng.token(5)}`,
  "faker.name": (rng) => `${rng.pick(FIRST)} ${rng.pick(LAST)}`,
  "faker.firstName": (rng) => rng.pick(FIRST),
  "faker.lastName": (rng) => rng.pick(LAST),
  "faker.email": (rng, { emailDomain }) =>
    `${lower(rng.pick(FIRST))}.${lower(rng.pick(LAST))}${rng.int(100)}@${emailDomain}`,
  "faker.company": (rng) => `${rng.pick(COMPANY_WORDS)} ${rng.pick(COMPANY_SUFFIXES)}`,
  "faker.phone": (rng) =>
    `+1 555 ${String(rng.int(1000)).padStart(3, "0")} ${String(rng.int(10000)).padStart(4, "0")}`,
  "faker.city": (rng) => rng.pick(CITIES),
};

/**
 * The set of generators the parser accepts and expansion uses. Add one with
 * `register("unique.slug", fn)`; the parser and expansion pick it up unchanged.
 */
export class GeneratorRegistry {
  readonly #generators = new Map<string, Generator>();

  constructor(generators: Readonly<Record<string, Generator>> = BUILT_IN_GENERATORS) {
    for (const [key, generator] of Object.entries(generators)) this.register(key, generator);
  }

  register(key: string, generator: Generator): this {
    if (!/^(unique|faker)\.[A-Za-z][A-Za-z0-9]*$/.test(key)) {
      throw new Error(`Generator key must be unique.<name> or faker.<name>, got "${key}"`);
    }
    this.#generators.set(key, generator);
    return this;
  }

  has(ns: string, member: string): boolean {
    return this.#generators.has(`${ns}.${member}`);
  }

  /** Members of a namespace, sorted (for messages and completions). */
  members(ns: string): string[] {
    return [...this.#generators.keys()]
      .filter((key) => key.startsWith(`${ns}.`))
      .map((key) => key.slice(ns.length + 1))
      .sort();
  }

  /**
   * The value for one use. `seed` is the run seed (include the worker), `where`
   * names the use (test id + location), so values are stable per seed.
   */
  generate(ns: string, member: string, seed: string, where: string, options: GeneratorOptions) {
    const generator = this.#generators.get(`${ns}.${member}`);
    if (!generator) return undefined;
    return generator(createRng(`${seed}\u0000${ns}.${member}\u0000${where}`), options);
  }
}

export const defaultGenerators: GeneratorRegistry = new GeneratorRegistry();

export const DEFAULT_EMAIL_DOMAIN = "example.test";
