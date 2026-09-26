import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brand } from "@testament/brand";
import type { CachedDecision, DecisionCache } from "../cache.js";

/** `<project>/<dataDir>/decisions/`. */
export function decisionsDir(projectDir: string): string {
  return join(projectDir, brand.dataDirName, "decisions");
}

/**
 * Decision cache on disk: one JSON file per key, named by the sha256 of the key.
 * Unreadable entries are misses. Writes are atomic (temp file + rename).
 */
export function fileCache(projectDir: string): DecisionCache & { readonly dir: string } {
  const dir = decisionsDir(projectDir);
  const path = (key: string) => join(dir, `${createHash("sha256").update(key).digest("hex")}.json`);
  return {
    dir,
    async get(key) {
      try {
        const value = JSON.parse(readFileSync(path(key), "utf8")) as CachedDecision & {
          key?: string;
        };
        // Guard against a (vanishingly unlikely) hash collision.
        if (value.key !== key || typeof value.storedAt !== "number") return undefined;
        return {
          answers: value.answers,
          confidence: value.confidence,
          source: value.source,
          storedAt: value.storedAt,
        };
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      mkdirSync(dir, { recursive: true });
      const target = path(key);
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify({ key, ...value })}\n`);
        renameSync(temp, target);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    },
  };
}
