import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let counter = 0;

/** Writes through a temp file and a rename, so readers never see half a file. */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${counter++}`;
  writeFileSync(temp, data, { flush: true });
  renameSync(temp, file);
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
