import { RetryExhaustedError, TimeoutError } from './errors';

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  factor?: number;
  jitterMs?: number;
  timeoutMs?: number;
  operationName?: string;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (context: { attempt: number; remainingRetries: number; delayMs: number; error: unknown }) => void;
}

export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const factor = options.factor ?? 2;
  const jitterMs = options.jitterMs ?? 250;
  const operationName = options.operationName ?? 'operation';

  let lastError: unknown;

  for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
    try {
      const result = options.timeoutMs
        ? await withTimeout(operation(), options.timeoutMs, operationName)
        : await operation();
      return result;
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt > options.retries;
      const allowRetry = options.shouldRetry ? options.shouldRetry(error, attempt) : defaultShouldRetry(error);

      if (isLastAttempt || !allowRetry) {
        throw new RetryExhaustedError(
          `${operationName} failed after ${attempt} attempt(s): ${extractErrorMessage(error)}`,
          { cause: error }
        );
      }

      const delayMs = nextDelay(options.baseDelayMs, options.maxDelayMs, factor, jitterMs, attempt);
      options.onRetry?.({
        attempt,
        remainingRetries: options.retries - attempt + 1,
        delayMs,
        error
      });

      await sleep(delayMs);
    }
  }

  throw new RetryExhaustedError(`${operationName} failed unexpectedly`, { cause: lastError });
}

function defaultShouldRetry(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return true;
  }

  const record = error as Record<string, unknown>;

  if (record.retryable === false) {
    return false;
  }

  if (typeof record.code === 'string') {
    const nonRetryableCodes = ['ERR_BAD_REQUEST'];
    if (nonRetryableCodes.includes(record.code)) {
      return false;
    }
  }

  return true;
}

function nextDelay(base: number, max: number, factor: number, jitterMs: number, attempt: number): number {
  const exponential = base * factor ** (attempt - 1);
  const capped = Math.min(exponential, max);
  const jitter = Math.floor(Math.random() * jitterMs);
  return capped + jitter;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new TimeoutError(`${operationName} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
