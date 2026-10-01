import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "@optestra/brand";

const SAMPLE = fileURLToPath(new URL("../examples/sample-project/", import.meta.url));
const created: string[] = [];

/** A temp copy of examples/sample-project under the real file names. */
export function sampleProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "config-sample-"));
  created.push(dir);
  for (const name of readdirSync(SAMPLE)) {
    const target =
      name === "config.yaml" ? brand.configFileName : name.startsWith("env") ? `.${name}` : name;
    cpSync(join(SAMPLE, name), join(dir, target));
  }
  return dir;
}

export function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "config-test-"));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

export function cleanup(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const SAMPLE_CONFIG_PATH = join(SAMPLE, "config.yaml");
