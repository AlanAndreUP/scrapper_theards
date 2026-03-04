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
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const FB_TOKEN_PATTERN = /\bEA[A-Za-z0-9_-]{20,}\b/g;
const GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z-_]{20,}\b/g;
const URL_TOKEN_PARAM_PATTERN = /([?&](?:access_token|token|api_key|apikey|key)=)[^&\s]+/gi;

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
    return redactSensitiveSubstrings(value);
  }

  return value;
}

function redactSensitiveSubstrings(value: string): string {
  return value
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(FB_TOKEN_PATTERN, '[REDACTED_FB_TOKEN]')
    .replace(GOOGLE_API_KEY_PATTERN, '[REDACTED_GOOGLE_API_KEY]')
    .replace(URL_TOKEN_PARAM_PATTERN, '$1[REDACTED]');
}
