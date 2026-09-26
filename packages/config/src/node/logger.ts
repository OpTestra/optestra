import { defaultRedactor, type Redactor } from "./redactor.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** Lowest level written. Default "info". */
  level?: LogLevel;
  /** Scrubs secrets from every line. Default: the process-wide redactor. */
  redactor?: Redactor;
  /** Where lines go. Default: stderr. */
  sink?: (line: string, level: LogLevel) => void;
}

function serialise(fields: LogFields): string {
  return JSON.stringify(fields, (_key, value: unknown) =>
    value instanceof Error ? { name: value.name, message: value.message } : value,
  );
}

/**
 * The engine logger. Every line passes through the redactor, so a secret value
 * (or its URL-encoded or base64 form) can never reach a log. All engine logging
 * goes through this.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVELS[options.level ?? "info"];
  const redactor = options.redactor ?? defaultRedactor;
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const write = (level: LogLevel) => (message: string, fields?: LogFields) => {
    if (LEVELS[level] < threshold) return;
    const line = fields ? `${level} ${message} ${serialise(fields)}` : `${level} ${message}`;
    sink(redactor.redact(line), level);
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

/** Default engine logger (info and above, to stderr). */
export const logger: Logger = createLogger();
