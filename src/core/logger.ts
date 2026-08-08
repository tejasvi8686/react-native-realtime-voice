/**
 * Opt-in logging. Silent by default so the package never spams a host app's
 * console — the existing AthleteOS implementation logged every tool call
 * unconditionally, which is exactly what this avoids.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const LEVEL_ORDER: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const PREFIX = "[realtime-voice]";

export function createLogger(level: LogLevel = "silent"): Logger {
  const threshold = level === "silent" ? Infinity : LEVEL_ORDER[level];
  const at = (l: Exclude<LogLevel, "silent">) => LEVEL_ORDER[l] >= threshold;
  return {
    debug: (m, ...a) => at("debug") && console.log(PREFIX, m, ...a),
    info: (m, ...a) => at("info") && console.log(PREFIX, m, ...a),
    warn: (m, ...a) => at("warn") && console.warn(PREFIX, m, ...a),
    error: (m, ...a) => at("error") && console.error(PREFIX, m, ...a),
  };
}

export const silentLogger: Logger = createLogger("silent");
