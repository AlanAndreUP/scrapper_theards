import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../src/db/state';
import { Logger } from '../src/utils/logger';

describe('StateStore', () => {
  let tempDir = '';
  let store: StateStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ig-pipeline-state-'));
    store = new StateStore(tempDir, new Logger({ level: 'error' }));
    await store.init();
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('marks and validates processed items by permalink + caption hash', async () => {
    const permalink = 'https://www.instagram.com/p/ABC123/';
    const captionHash = 'hash-1';

    expect(await store.isProcessed(permalink, captionHash)).toBe(false);

    await store.markProcessed({
      permalink,
      captionHash,
      shortcode: 'ABC123',
      processedAt: new Date().toISOString(),
      facebookPostId: '1234567890'
    });

    expect(await store.isProcessed(permalink, captionHash)).toBe(true);
    expect(await store.isProcessed(permalink, 'hash-2')).toBe(false);
  });

  it('stores run logs persistently', async () => {
    await store.appendRunLog({
      runAt: new Date().toISOString(),
      durationMs: 100,
      status: 'success',
      detail: 'pipeline ok'
    });

    const secondStore = new StateStore(tempDir, new Logger({ level: 'error' }));
    await secondStore.init();

    expect(secondStore.getLastProcessed()).toBeNull();
  });
});
