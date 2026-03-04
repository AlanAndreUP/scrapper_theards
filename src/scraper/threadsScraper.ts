import { chromium, type Page } from 'playwright';
import { ScraperExtractionError } from '../utils/errors';
import type { Logger } from '../utils/logger';
import type { InstagramPost, InstagramMediaType } from './instagramScraper';

const THREADS_POST_LINK_SELECTOR = 'a[href*="/post/"]';

interface ThreadsExtract {
  url: string;
  ogUrl: string;
  ogDescription: string;
  ogImage: string;
  metaDescription: string;
}

export class ThreadsScraper {
  constructor(
    private readonly logger: Logger,
    private readonly requestTimeoutMs: number,
    private readonly headless: boolean,
    private readonly disableSandbox = true
  ) {}

  async getLatestPost(profileUrl: string): Promise<InstagramPost> {
    const launchArgs = this.disableSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
    const browser = await chromium.launch({ headless: this.headless, args: launchArgs });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      locale: 'es-ES'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(this.requestTimeoutMs);

    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: this.requestTimeoutMs });
      await page.waitForLoadState('networkidle', { timeout: this.requestTimeoutMs }).catch(() => undefined);

      const latestPostUrl = await resolveLatestThreadsPostUrl(page);
      if (!latestPostUrl) {
        throw markAsNonRetryable(new ScraperExtractionError('No se encontró post reciente en Threads.'));
      }

      await page.goto(latestPostUrl, { waitUntil: 'domcontentloaded', timeout: this.requestTimeoutMs });
      await page.waitForLoadState('networkidle', { timeout: this.requestTimeoutMs }).catch(() => undefined);

      const extracted = await page.evaluate<ThreadsExtract>(() => {
        const getMeta = (selector: string): string => {
          const element = document.querySelector<HTMLMetaElement>(selector);
          return element?.content ?? '';
        };

        return {
          url: window.location.href,
          ogUrl: getMeta('meta[property="og:url"]'),
          ogDescription: getMeta('meta[property="og:description"]'),
          ogImage: getMeta('meta[property="og:image"]'),
          metaDescription: getMeta('meta[name="description"]')
        };
      });

      const permalink = normalizeThreadsPermalink(extracted.ogUrl || extracted.url || latestPostUrl);
      const shortcode = extractThreadsPostId(permalink);
      if (!shortcode) {
        throw new ScraperExtractionError('No se pudo extraer el ID del post de Threads.');
      }

      const caption = (extracted.ogDescription || extracted.metaDescription || '').trim();
      const mediaUrls = extracted.ogImage && /^https?:\/\//i.test(extracted.ogImage) ? [extracted.ogImage] : [];

      if (mediaUrls.length === 0) {
        throw new ScraperExtractionError('El último post de Threads no tiene imagen disponible en meta tags.');
      }

      const mediaType: InstagramMediaType = 'IMAGE';
      const result: InstagramPost = {
        shortcode,
        permalink,
        caption,
        mediaUrls,
        mediaType
      };

      this.logger.debug('Threads latest post extracted', {
        permalink,
        shortcode,
        mediaCount: mediaUrls.length
      });

      return result;
    } catch (error) {
      if (error instanceof ScraperExtractionError) {
        throw error;
      }

      throw new ScraperExtractionError(`Error extrayendo Threads: ${getErrorMessage(error)}`, { cause: error });
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

async function resolveLatestThreadsPostUrl(page: Page): Promise<string | null> {
  await page.waitForSelector(THREADS_POST_LINK_SELECTOR, { timeout: 8_000 }).catch(() => undefined);

  const fromDom = await page.evaluate((selector) => {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector));
    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) {
        continue;
      }

      const absolute = /^https?:\/\/www\.threads\.net\/[^/]+\/post\/[A-Za-z0-9_-]+\/?/i.exec(href);
      if (absolute?.[0]) {
        return absolute[0];
      }

      const path = /\/[A-Za-z0-9._]+\/post\/[A-Za-z0-9_-]+\/?/.exec(href);
      if (path?.[0]) {
        return new URL(path[0], 'https://www.threads.net').toString();
      }
    }

    return null;
  }, THREADS_POST_LINK_SELECTOR);

  if (fromDom) {
    return normalizeThreadsPermalink(fromDom);
  }

  const html = await page.content();
  const fromHtml = extractThreadsPostUrlFromHtml(html);
  return fromHtml ? normalizeThreadsPermalink(fromHtml) : null;
}

function extractThreadsPostUrlFromHtml(html: string): string | null {
  const direct = /https?:\/\/www\.threads\.net\/[A-Za-z0-9._]+\/post\/[A-Za-z0-9_-]+\/?/i.exec(html);
  if (direct?.[0]) {
    return direct[0];
  }

  const escaped = /https?:\\\/\\\/www\.threads\.net\\\/[A-Za-z0-9._]+\\\/post\\\/[A-Za-z0-9_-]+\\\/?/i.exec(html);
  if (escaped?.[0]) {
    return escaped[0].replace(/\\\//g, '/');
  }

  return null;
}

function normalizeThreadsPermalink(value: string): string {
  const normalized = value.split('?')[0]?.trim() ?? value.trim();
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
  }
  return `https://www.threads.net${normalized.startsWith('/') ? normalized : `/${normalized}`}`;
}

function extractThreadsPostId(permalink: string): string | null {
  const match = /\/post\/([A-Za-z0-9_-]+)/.exec(permalink);
  return match?.[1] ?? null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function markAsNonRetryable<T extends Error>(error: T): T & { retryable: false } {
  const enriched = error as T & { retryable: false };
  enriched.retryable = false;
  return enriched;
}
