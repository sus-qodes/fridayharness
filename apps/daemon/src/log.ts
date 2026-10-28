import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  /** JSON-lines file, e.g. `.friday/logs/daemon.jsonl`. */
  file?: string;
  level?: Level;
  /** Also print a short human line to stderr. */
  console?: boolean;
  /** Applied to every serialized line (secret redaction). */
  redact?: (line: string) => string;
}

/**
 * Small structured logger (JSON lines). Kept dependency-free so it behaves the same on every
 * platform; every line passes through the redactor so tokens never reach the log file.
 */
export function createLogger(opts: LoggerOptions = {}, base: Record<string, unknown> = {}): Logger {
  const min = RANK[opts.level ?? 'info'];
  if (opts.file) mkdirSync(path.dirname(opts.file), { recursive: true });
  const redact = opts.redact ?? ((s: string) => s);
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (RANK[level] < min) return;
    const record = { time: new Date().toISOString(), level, msg, ...base, ...fields };
    const line = redact(JSON.stringify(record));
    if (opts.file) {
      try {
        appendFileSync(opts.file, `${line}\n`);
      } catch {
        // logging must never break the daemon
      }
    }
    if (opts.console) process.stderr.write(`${redact(`[friday] ${level.padEnd(5)} ${msg}`)}\n`);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger(opts, { ...base, ...fields }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
