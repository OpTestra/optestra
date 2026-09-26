import { z } from "zod";
import { ArtifactKindSchema } from "./enums.js";
import { CONTRACT_MAJOR } from "./version.js";

/** Any minor of the current major. */
export const ContractVersionSchema = z
  .string()
  .regex(new RegExp(`^${CONTRACT_MAJOR}\\.\\d+$`), `must be ${CONTRACT_MAJOR}.<minor>`);

export const TimestampSchema = z.iso.datetime();
export const CountSchema = z.number().int().nonnegative();
export const MillisecondsSchema = z.number().nonnegative();
export const IdSchema = z.string().min(1);
export const ConfidenceSchema = z.number().min(0).max(1);
export const UsdSchema = z.number().nonnegative();

/** Crockford base32, 26 characters. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const RunIdSchema = z.string().regex(ULID_PATTERN, "must be a ULID");

/** A relative, forward-slash path that stays inside the run folder. */
export function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  return path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && isPortableSegment(part));
}

/** Characters no Windows, macOS or Linux file name may contain (plus control characters). */
const NON_PORTABLE_CHARS = new Set(["<", ">", ":", '"', "|", "?", "*"]);
/** Names Windows reserves for devices, with or without an extension. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const isNonPortableChar = (char: string) =>
  NON_PORTABLE_CHARS.has(char) || char.charCodeAt(0) < 0x20;

/** True when `part` is a valid file or folder name on every supported OS. */
export function isPortableSegment(part: string): boolean {
  return ![...part].some(isNonPortableChar) && !RESERVED_NAME.test(part) && !/[. ]$/.test(part);
}

/**
 * Makes one path segment valid on every supported OS: non-portable characters
 * become "-", trailing dots and spaces are dropped, and reserved device names
 * get a "_" prefix. Portable segments are returned unchanged.
 */
export function portableSegment(part: string): string {
  if (isPortableSegment(part)) return part;
  let out = [...part]
    .map((char) => (isNonPortableChar(char) ? "-" : char))
    .join("")
    .replace(/[. ]+$/, "");
  if (out === "") out = "_";
  return RESERVED_NAME.test(out) ? `_${out}` : out;
}

/**
 * Applies `portableSegment` to every segment of a "/"-separated relative path.
 * Empty, "." and ".." segments are left as they are, so `isSafeRelativePath`
 * still refuses them rather than having them silently renamed.
 */
export function portablePath(path: string): string {
  return path
    .split("/")
    .map((part) => (part === "" || part === "." || part === ".." ? part : portableSegment(part)))
    .join("/");
}

export const RelativePathSchema = z
  .string()
  .refine(isSafeRelativePath, "must be a relative path inside the run folder");

export const TokensSchema = z.object({
  /** All input tokens, including cached ones. */
  input: CountSchema,
  output: CountSchema,
  cached: CountSchema,
  cacheWrite: CountSchema.default(0),
});
export type Tokens = z.infer<typeof TokensSchema>;

export const ArtifactRefSchema = z.object({
  kind: ArtifactKindSchema,
  path: RelativePathSchema,
  contentType: z.string().min(1),
  bytes: CountSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Always true: the writer refuses artifacts the producer has not scrubbed (EVD-5). */
  scrubbed: z.literal(true),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
