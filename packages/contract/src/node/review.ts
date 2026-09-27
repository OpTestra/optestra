import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type HealReview, HealReviewSchema } from "../heal.js";
import { runLayout } from "../layout.js";
import { serializeDocument } from "../serialize.js";
import { writeFileAtomic } from "./fs.js";

/** A finished run's heal review decisions (`heals/review.json`), or null when there are none. */
export function readHealReview(dir: string): HealReview | null {
  const file = join(dir, runLayout.healReview);
  if (!existsSync(file)) return null;
  try {
    const parsed = HealReviewSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Writes the review decisions atomically (the run's own documents are never changed). */
export function writeHealReview(dir: string, review: HealReview): void {
  writeFileAtomic(
    join(dir, runLayout.healReview),
    serializeDocument(HealReviewSchema.parse(review)),
  );
}
