import type { Config } from "@testament/config";

/**
 * Tracks AI spend against a cap (MOD-5). Checked before every call; actual cost
 * is added after it. One call already in flight when the cap is reached may
 * overshoot it: the cap stops the NEXT call, it cannot cancel a running one.
 */
export class BudgetMeter {
  #spent = 0;
  #unknown = 0;

  constructor(
    /** e.g. "run" or "suite". */
    readonly label: string,
    /** null = no cap. */
    readonly capUsd: number | null,
    /** Config setting that sets the cap, for messages. */
    readonly setting?: string,
  ) {}

  static forRun(config: Config): BudgetMeter {
    return new BudgetMeter("run", config.run.budget.maxPerRunUsd, "run.budget.maxPerRunUsd");
  }

  static forSuite(config: Config): BudgetMeter {
    return new BudgetMeter("suite", config.run.budget.maxPerSuiteUsd, "run.budget.maxPerSuiteUsd");
  }

  get spentUsd(): number {
    return this.#spent;
  }

  /** Calls whose cost could not be determined (unknown price). */
  get unknownCostCalls(): number {
    return this.#unknown;
  }

  get exhausted(): boolean {
    return this.capUsd !== null && this.#spent >= this.capUsd;
  }

  add(costUsd: number | null): void {
    if (costUsd === null) this.#unknown++;
    else this.#spent += costUsd;
  }
}
