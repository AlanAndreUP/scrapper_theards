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

const envSchema = z.object({
  IG_PROFILE_URL: z.string().url(),
  THREADS_PROFILE_URL: z.string().url().optional(),
  ENABLE_THREADS_FALLBACK: booleanFromEnv.default(true),
  POLL_MINUTES: z.coerce.number().int().min(1).max(59).default(5),
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
};

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const formatted = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment variables: ${formatted}`);
  }

  return {
    ...parsed.data,
    DATA_DIR: resolve(parsed.data.DATA_DIR),
    R2_PUBLIC_BASE_URL: normalizeBaseUrl(parsed.data.R2_PUBLIC_BASE_URL)
  };
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
