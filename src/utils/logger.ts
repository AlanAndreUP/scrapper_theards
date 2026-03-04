import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|api[_-]?key|access[_-]?key)/i;

export interface LoggerOptions {
  level?: LogLevel;
  logFilePath?: string;
}

export class Logger {
  private readonly minLevel: LogLevel;
  private readonly logFilePath: string | undefined;

  constructor(options: LoggerOptions = {}) {
    this.minLevel = options.level ?? 'info';
    this.logFilePath = options.logFilePath;

    if (this.logFilePath) {
      mkdirSync(dirname(this.logFilePath), { recursive: true });
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message
    };

    if (meta && Object.keys(meta).length > 0) {
      entry.meta = sanitize(meta);
    }

    const line = JSON.stringify(entry);

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }

    if (this.logFilePath) {
      appendFileSync(this.logFilePath, `${line}\n`, { encoding: 'utf8' });
    }
  }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }

  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};

    for (const [key, nested] of Object.entries(objectValue)) {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitize(nested);
    }

    return redacted;
  }

  if (typeof value === 'string') {
    if (value.length > 120 && /[A-Za-z0-9_-]{30,}/.test(value)) {
      return '[REDACTED]';
    }
  }

  return value;
}
