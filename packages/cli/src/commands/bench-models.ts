import type { BenchCommandOptions } from "./bench.js";
import type { CommandIo } from "./config.js";

export async function runModelEvalCommand(
  _options: BenchCommandOptions,
  io: CommandIo,
): Promise<number> {
  io.stdout("not yet\n");
  return 2;
}
