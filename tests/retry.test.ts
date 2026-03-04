import { describe, expect, it } from 'vitest';
import { retry } from '../src/utils/retry';

describe('retry', () => {
  it('returns successful result after transient failures', async () => {
    let attempts = 0;

    const result = await retry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('temporary failure');
        }

        return 'ok';
      },
      {
        retries: 3,
        baseDelayMs: 1,
        maxDelayMs: 5,
        timeoutMs: 1_000,
        operationName: 'retry.test.success'
      }
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry when error is marked as non-retryable', async () => {
    let attempts = 0;

    await expect(
      retry(
        async () => {
          attempts += 1;
          const error = new Error('bad request') as Error & { retryable?: boolean };
          error.retryable = false;
          throw error;
        },
        {
          retries: 4,
          baseDelayMs: 1,
          maxDelayMs: 5,
          operationName: 'retry.test.nonretryable'
        }
      )
    ).rejects.toThrow(/failed after 1 attempt/i);

    expect(attempts).toBe(1);
  });
});
