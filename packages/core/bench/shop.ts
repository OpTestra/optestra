// The Acme Shop fixture for the bench scripts (perf): Bench's own drivers
// (`@optestra/core/bench`), with the shop found once.

import type { RunTestsOptions, RunTestsResult } from "@optestra/core/node";
import {
  mailpitRunning,
  runShopVariant,
  type SpecRun,
  shopFixture,
  specShop as specRun,
} from "@optestra/core/bench";

export { mailpitRunning };

const shop = await shopFixture();

/** Replays the shop's tests on one variant (see runShopVariant). */
export function replayShop(
  variant: string,
  options: { useMailpit: boolean; keep?: boolean } & Partial<RunTestsOptions>,
): Promise<{ run: RunTestsResult; ms: number; dir: string }> {
  return runShopVariant(shop, variant, options);
}

/** The generated specs as plain Playwright. */
export function specShop(variant: string, useMailpit: boolean): Promise<SpecRun> {
  return specRun(shop, variant, useMailpit);
}
