import { createRequire } from "node:module";

export {
  createLogger,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  logger,
} from "@testament/config/node";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** Engine version, taken from this package's package.json. */
export function version(): string {
  return pkg.version;
}
