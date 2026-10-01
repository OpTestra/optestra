import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brand } from "@optestra/brand";
import type { ProviderSettings } from "./config.js";

export interface UsageEntry {
  provider: string;
  usd: number;
  /** Epoch milliseconds. */
  at: number;
}

/**
 * Spend per provider over time, for usage caps. The cloud will provide a shared
 * implementation; this package ships a file store and an in-memory store.
 */
export interface UsageStore {
  record(entry: UsageEntry): Promise<void>;
  /** Total USD spent on `provider` since `since` (epoch ms). */
  spentSince(provider: string, since: number): Promise<number>;
}

const HOUR = 3_600_000;
export const CAP_WINDOWS = {
  per5h: 5 * HOUR,
  perWeek: 7 * 24 * HOUR,
  perMonth: 30 * 24 * HOUR,
} as const;
export type CapWindow = keyof typeof CAP_WINDOWS;

export class MemoryUsageStore implements UsageStore {
  readonly entries: UsageEntry[] = [];

  async record(entry: UsageEntry): Promise<void> {
    this.entries.push(entry);
  }

  async spentSince(provider: string, since: number): Promise<number> {
    return this.entries
      .filter((e) => e.provider === provider && e.at >= since)
      .reduce((sum, e) => sum + e.usd, 0);
  }
}

/** JSON file store. Keeps 31 days of entries. Best effort across concurrent processes. */
export class FileUsageStore implements UsageStore {
  constructor(readonly path: string) {}

  #read(): UsageEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as { entries?: unknown };
      return Array.isArray(data.entries) ? (data.entries as UsageEntry[]) : [];
    } catch {
      return [];
    }
  }

  async record(entry: UsageEntry): Promise<void> {
    const cutoff = entry.at - 31 * 24 * HOUR;
    const entries = [...this.#read().filter((e) => e.at >= cutoff), entry];
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify({ entries })}\n`);
      renameSync(temp, this.path);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  async spentSince(provider: string, since: number): Promise<number> {
    return this.#read()
      .filter((e) => e.provider === provider && e.at >= since)
      .reduce((sum, e) => sum + e.usd, 0);
  }
}

/** The project's usage file: `<project>/<dataDir>/usage.json`. */
export function projectUsageStore(projectDir: string): FileUsageStore {
  return new FileUsageStore(join(projectDir, brand.dataDirName, "usage.json"));
}

export interface CapUsage {
  window: CapWindow;
  spentUsd: number;
  capUsd: number;
  ratio: number;
}

/** Spend against each configured cap of a provider. */
export async function capUsage(
  store: UsageStore,
  provider: string,
  caps: ProviderSettings["caps"],
  now: number = Date.now(),
): Promise<CapUsage[]> {
  const out: CapUsage[] = [];
  for (const window of Object.keys(CAP_WINDOWS) as CapWindow[]) {
    const cap = caps?.[window];
    if (!cap) continue;
    const spentUsd = await store.spentSince(provider, now - CAP_WINDOWS[window]);
    out.push({ window, spentUsd, capUsd: cap.usd, ratio: spentUsd / cap.usd });
  }
  return out;
}

/** Share of a cap at which calls move on to the next provider. */
export const NEAR_CAP_RATIO = 0.9;
