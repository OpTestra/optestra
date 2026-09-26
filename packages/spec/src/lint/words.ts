import { BUILT_IN_WORDS } from "./words.generated.js";

/** The data behind the lint rules (lint-words.yaml). */
export interface LintWords {
  vaguePhrases: string[];
  targetVerbs: string[];
  emptyTargets: string[];
  elementNouns: string[];
  stateWords: string[];
  vagueGuardWords: string[];
  navigationVerbs: string[];
  destructive: Record<string, string[]>;
  credentialFields: Record<string, string>;
  credentialMinLength: number;
  tokenPatterns: string[];
  signupWords: string[];
  fixedWaitPatterns: string[];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Longest first, so "double click" wins over "click". */
const alternation = (phrases: readonly string[]) =>
  [...phrases]
    .sort((a, b) => b.length - a.length)
    .map((p) => escapeRegExp(p.trim()).replace(/\s+/g, "\\s+"))
    .join("|");
const words = (phrases: readonly string[], suffix = "") =>
  new RegExp(`(?<![\\w-])(?:${alternation(phrases)})${suffix}(?![\\w-])`, "i");

/** Word lists compiled into matchers, once per word set. */
export interface CompiledWords {
  source: LintWords;
  vague: RegExp;
  verbOnly: RegExp;
  noun: RegExp;
  state: RegExp;
  vagueGuard: RegExp;
  navigation: RegExp;
  destructive: { action: string; pattern: RegExp }[];
  credentialField: RegExp;
  tokens: RegExp[];
  signup: RegExp;
  fixedWait: RegExp[];
}

const cache = new WeakMap<LintWords, CompiledWords>();

export function compileWords(source: LintWords = BUILT_IN_WORDS): CompiledWords {
  const cached = cache.get(source);
  if (cached) return cached;
  const compiled: CompiledWords = {
    source,
    vague: words(source.vaguePhrases),
    // The whole step is a target verb, optionally followed by an empty target.
    verbOnly: new RegExp(
      `^\\s*(?:${alternation(source.targetVerbs)})(?:\\s+(?:on\\s+|in\\s+)?(?:${alternation(source.emptyTargets)}))?\\s*[.!]?\\s*$`,
      "i",
    ),
    noun: words(source.elementNouns, "(?:e?s)?"),
    state: words(source.stateWords),
    vagueGuard: words(source.vagueGuardWords),
    navigation: new RegExp(`^\\s*(?:${alternation(source.navigationVerbs)})(?![\\w-])`, "i"),
    destructive: Object.entries(source.destructive).map(([action, phrases]) => ({
      action,
      pattern: words(phrases, "(?:s|es|ed|ing)?"),
    })),
    credentialField: new RegExp(
      `(?<![\\w-])(${alternation(Object.keys(source.credentialFields))})(?![\\w-])`,
      "i",
    ),
    tokens: source.tokenPatterns.map((p) => new RegExp(p)),
    signup: words(source.signupWords),
    fixedWait: source.fixedWaitPatterns.map((p) => new RegExp(p, "i")),
  };
  cache.set(source, compiled);
  return compiled;
}

export { BUILT_IN_WORDS };
