import { brand } from "@testament/brand";
import { version } from "@testament/core";
import { Command } from "commander";

export function createProgram(): Command {
  const program = new Command()
    .name(brand.cliName)
    .description(
      `${brand.productName}: test websites and Android apps from plain-English descriptions.`,
    )
    .version(version(), "-v, --version", "print the engine version")
    .helpOption("-h, --help", "show this help");
  program.action(() => program.help());
  return program;
}
