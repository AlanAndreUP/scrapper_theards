import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GeminiClient } from './ai/gemini';
import { loadEnv } from './config/env';
import { StateStore } from './db/state';
import { FacebookPublisher } from './publisher/facebook';
import { InstagramScraper } from './scraper/instagramScraper';
import { ThreadsScraper } from './scraper/threadsScraper';
import { Poller } from './scheduler/poller';
import { R2Storage } from './storage/r2';
import { Logger } from './utils/logger';

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  mkdirSync(env.DATA_DIR, { recursive: true });

  const logger = new Logger({
    level: env.LOG_LEVEL,
    logFilePath: join(env.DATA_DIR, 'logs', 'app.log')
  });

  logger.info('Starting Instagram -> Gemini -> Facebook pipeline', {
    watchTargets: env.WATCH_TARGETS,
    pollMinutes: env.POLL_MINUTES,
    dataDir: env.DATA_DIR,
    igUseAuthSession: env.IG_USE_AUTH_SESSION,
    storageStatePath: env.PLAYWRIGHT_STORAGE_STATE_PATH
  });

  const stateStore = new StateStore(env.DATA_DIR, logger);
  await stateStore.init();

  await hydrateInstagramStorageStateFromEnv({
    useAuthSession: env.IG_USE_AUTH_SESSION,
    storageStatePath: env.PLAYWRIGHT_STORAGE_STATE_PATH,
    storageStateBase64: env.PLAYWRIGHT_STORAGE_STATE_B64,
    logger
  });

  const scraper = new InstagramScraper(logger, env.REQUEST_TIMEOUT_MS, env.PLAYWRIGHT_HEADLESS, {
    useAuthSession: env.IG_USE_AUTH_SESSION,
    storageStatePath: env.PLAYWRIGHT_STORAGE_STATE_PATH,
    disableSandbox: env.PLAYWRIGHT_DISABLE_SANDBOX
  });
  const threadsScraper = env.WATCH_TARGETS.some((target) => Boolean(target.threadsUrl))
    ? new ThreadsScraper(logger, env.REQUEST_TIMEOUT_MS, env.PLAYWRIGHT_HEADLESS, env.PLAYWRIGHT_DISABLE_SANDBOX)
    : undefined;

  const r2 = new R2Storage(
    {
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
      region: env.R2_REGION,
      publicBaseUrl: env.R2_PUBLIC_BASE_URL
    },
    logger
  );

  const gemini = new GeminiClient(
    {
      apiKey: env.GEMINI_API_KEY,
      textModel: env.GEMINI_MODEL_TEXT,
      imageModel: env.GEMINI_MODEL_IMAGE,
      timeoutMs: env.REQUEST_TIMEOUT_MS
    },
    logger
  );

  const facebook = new FacebookPublisher(
    {
      graphVersion: env.FB_GRAPH_VERSION,
      timeoutMs: env.REQUEST_TIMEOUT_MS
    },
    logger
  );

  const poller = new Poller(
    {
      targets: env.WATCH_TARGETS,
      pollMinutes: env.POLL_MINUTES,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
      maxRetries: env.MAX_RETRIES,
      retryBaseDelayMs: env.RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: env.RETRY_MAX_DELAY_MS,
      facebookPageId: env.FB_PAGE_ID,
      facebookPageAccessToken: env.FB_PAGE_ACCESS_TOKEN
    },
    {
      scraper,
      ...(threadsScraper ? { threadsScraper } : {}),
      stateStore,
      r2,
      gemini,
      facebook,
      logger
    }
  );

  poller.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutdown signal received', { signal });
    await poller.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message });
  });
}

void bootstrap();

async function hydrateInstagramStorageStateFromEnv(params: {
  useAuthSession: boolean;
  storageStatePath: string;
  storageStateBase64: string | undefined;
  logger: Logger;
}): Promise<void> {
  if (!params.useAuthSession) {
    return;
  }

  if (!params.storageStateBase64) {
    return;
  }

  try {
    const decoded = Buffer.from(params.storageStateBase64, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as { cookies?: unknown[]; origins?: unknown[] };
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
      throw new Error('Decoded storage state must contain cookies[] and origins[].');
    }

    mkdirSync(dirname(params.storageStatePath), { recursive: true });
    await writeFile(params.storageStatePath, decoded, 'utf8');

    params.logger.info('Instagram storage state loaded from PLAYWRIGHT_STORAGE_STATE_B64', {
      storageStatePath: params.storageStatePath
    });
  } catch (error) {
    params.logger.error('Failed to decode PLAYWRIGHT_STORAGE_STATE_B64', {
      error: error instanceof Error ? error.message : String(error),
      storageStatePath: params.storageStatePath
    });
    throw error;
  }
}
