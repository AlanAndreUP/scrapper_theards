import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
    profileUrl: env.IG_PROFILE_URL,
    pollMinutes: env.POLL_MINUTES,
    dataDir: env.DATA_DIR
  });

  const stateStore = new StateStore(env.DATA_DIR, logger);
  await stateStore.init();

  const scraper = new InstagramScraper(logger, env.REQUEST_TIMEOUT_MS, env.PLAYWRIGHT_HEADLESS);
  const threadsScraper = env.THREADS_PROFILE_URL
    ? new ThreadsScraper(logger, env.REQUEST_TIMEOUT_MS, env.PLAYWRIGHT_HEADLESS)
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
      profileUrl: env.IG_PROFILE_URL,
      ...(env.THREADS_PROFILE_URL ? { threadsProfileUrl: env.THREADS_PROFILE_URL } : {}),
      enableThreadsFallback: env.ENABLE_THREADS_FALLBACK,
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
