import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n'].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

export interface WatchTarget {
  instagramUrl: string;
  threadsUrl?: string;
}

const envSchema = z.object({
  IG_PROFILE_URL: z.string().url().optional(),
  IG_PROFILE_URLS: z.string().optional(),
  THREADS_PROFILE_URL: z.string().url().optional(),
  THREADS_PROFILE_URLS: z.string().optional(),
  ENABLE_THREADS_FALLBACK: booleanFromEnv.default(true),
  IG_USE_AUTH_SESSION: booleanFromEnv.default(false),
  PLAYWRIGHT_STORAGE_STATE_PATH: z.string().default('./data/instagram-storage-state.json'),
  PLAYWRIGHT_STORAGE_STATE_B64: z.string().optional(),
  PLAYWRIGHT_DISABLE_SANDBOX: booleanFromEnv.default(true),

  POLL_MINUTES: z.coerce
    .number()
    .int()
    .default(30)
    .refine((value) => value === 30, { message: 'POLL_MINUTES must be 30 by business rule.' }),
  DATA_DIR: z.string().default('./data'),

  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_PUBLIC_BASE_URL: z.string().url(),
  R2_REGION: z.string().min(1).default('auto'),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL_TEXT: z.string().min(1),
  GEMINI_MODEL_IMAGE: z.string().min(1),

  FB_PAGE_ID: z.string().min(1),
  FB_PAGE_ACCESS_TOKEN: z.string().min(1),
  FB_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v25.0'),

  MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().min(500).max(120_000).default(15_000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  PLAYWRIGHT_HEADLESS: booleanFromEnv.default(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
});

export type Env = z.infer<typeof envSchema> & {
  DATA_DIR: string;
  R2_PUBLIC_BASE_URL: string;
  PLAYWRIGHT_STORAGE_STATE_PATH: string;
  WATCH_TARGETS: WatchTarget[];
};

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const formatted = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment variables: ${formatted}`);
  }

  const instagramUrls = uniqueUrls([
    ...parseUrlList(parsed.data.IG_PROFILE_URLS, 'instagram'),
    ...(parsed.data.IG_PROFILE_URL ? [normalizePlatformUrl(parsed.data.IG_PROFILE_URL, 'instagram')] : [])
  ]);

  if (instagramUrls.length === 0) {
    throw new Error('Invalid environment variables: define IG_PROFILE_URL or IG_PROFILE_URLS with at least one URL.');
  }

  const threadsUrls = uniqueUrls([
    ...parseUrlList(parsed.data.THREADS_PROFILE_URLS, 'threads'),
    ...(parsed.data.THREADS_PROFILE_URL ? [normalizePlatformUrl(parsed.data.THREADS_PROFILE_URL, 'threads')] : [])
  ]);

  const watchTargets = buildWatchTargets(instagramUrls, threadsUrls, parsed.data.ENABLE_THREADS_FALLBACK);

  const firstTarget = watchTargets[0];

  return {
    ...parsed.data,
    IG_PROFILE_URL: instagramUrls[0],
    ...(firstTarget?.threadsUrl ? { THREADS_PROFILE_URL: firstTarget.threadsUrl } : {}),
    DATA_DIR: resolve(parsed.data.DATA_DIR),
    PLAYWRIGHT_STORAGE_STATE_PATH: resolve(parsed.data.PLAYWRIGHT_STORAGE_STATE_PATH),
    R2_PUBLIC_BASE_URL: normalizeBaseUrl(parsed.data.R2_PUBLIC_BASE_URL),
    WATCH_TARGETS: watchTargets
  };
}

function parseUrlList(rawValue: string | undefined, platform: 'instagram' | 'threads'): string[] {
  if (!rawValue) {
    return [];
  }

  const values = rawValue
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return values.map((value) => normalizePlatformUrl(value, platform));
}

function normalizePlatformUrl(value: string, platform: 'instagram' | 'threads'): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${platform} URL in list: ${value}`);
  }

  if (platform === 'instagram' && !parsed.hostname.includes('instagram.com')) {
    throw new Error(`Invalid instagram URL hostname: ${value}`);
  }

  if (platform === 'threads') {
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname.includes('threads.net') && !hostname.includes('threads.com')) {
      throw new Error(`Invalid threads URL hostname: ${value}`);
    }

    parsed.hostname = 'www.threads.net';
  }

  parsed.search = '';
  parsed.hash = '';

  const normalizedPath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  parsed.pathname = normalizedPath;

  return parsed.toString();
}

function buildWatchTargets(instagramUrls: string[], threadsUrls: string[], enableThreadsFallback: boolean): WatchTarget[] {
  if (!enableThreadsFallback || threadsUrls.length === 0) {
    return instagramUrls.map((instagramUrl) => ({ instagramUrl }));
  }

  const threadsByUsername = new Map<string, string>();
  for (const threadsUrl of threadsUrls) {
    const username = extractThreadsUsername(threadsUrl);
    if (username) {
      threadsByUsername.set(username, threadsUrl);
    }
  }

  const fallbackThreadsUrl = threadsUrls[0];

  return instagramUrls.map((instagramUrl) => {
    const instagramUsername = extractInstagramUsername(instagramUrl);
    const matchedThreadsUrl = instagramUsername ? threadsByUsername.get(instagramUsername) : undefined;

    if (matchedThreadsUrl) {
      return {
        instagramUrl,
        threadsUrl: matchedThreadsUrl
      };
    }

    // Backward compatibility for single profile setup.
    if (instagramUrls.length === 1 && fallbackThreadsUrl) {
      return {
        instagramUrl,
        threadsUrl: fallbackThreadsUrl
      };
    }

    return { instagramUrl };
  });
}

function extractInstagramUsername(instagramUrl: string): string | null {
  const parsed = new URL(instagramUrl);
  const firstSegment = parsed.pathname.split('/').find((segment) => segment.length > 0);
  return firstSegment?.toLowerCase() ?? null;
}

function extractThreadsUsername(threadsUrl: string): string | null {
  const parsed = new URL(threadsUrl);
  const firstSegment = parsed.pathname.split('/').find((segment) => segment.length > 0);
  if (!firstSegment) {
    return null;
  }

  return firstSegment.replace(/^@/, '').toLowerCase();
}

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const url of urls) {
    if (!seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }

  return result;
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
