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
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
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
