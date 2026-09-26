import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const MANIFEST_PATH = fileURLToPath(new URL("../manifest.yaml", import.meta.url));

export const VERDICTS = ["passed", "failed", "flaky", "blocked"] as const;
export const CAUSES = ["product_bug", "test_drift", "environment", "test_data", "blocked"] as const;

export type Verdict = (typeof VERDICTS)[number];

export interface Expectation {
  verdict: Verdict;
  step?: number;
  cause?: (typeof CAUSES)[number];
  reason?: string;
}

export interface Manifest {
  version: number;
  fixture: string;
  tests_dir: string;
  harness: Record<string, unknown>;
  variants: Record<string, { also_accept?: Partial<Record<Verdict, string[]>> }>;
  tests: Record<string, Record<string, Verdict | Expectation>>;
}

export function readManifest(path = MANIFEST_PATH): Manifest {
  return parse(readFileSync(path, "utf8")) as Manifest;
}

export function expectation(manifest: Manifest, test: string, variant: string): Expectation {
  const entry = manifest.tests[test]?.[variant];
  if (entry === undefined) throw new Error(`manifest has no answer for ${test} × ${variant}`);
  return typeof entry === "string" ? { verdict: entry } : entry;
}
