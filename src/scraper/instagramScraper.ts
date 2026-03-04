import { chromium, type APIRequestContext, type Page } from 'playwright';
import { ScraperExtractionError } from '../utils/errors';
import type { Logger } from '../utils/logger';

export type InstagramMediaType = 'IMAGE' | 'CAROUSEL' | 'REEL';

export interface InstagramPost {
  shortcode: string;
  permalink: string;
  caption: string;
  mediaUrls: string[];
  mediaType: InstagramMediaType;
  thumbnailUrl?: string;
}

interface RawPostExtract {
  permalink: string;
  ogUrl: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  ldCaption: string;
  ldImages: string[];
  visibleCaption: string;
  pathname: string;
}

interface WebProfileInfoResponse {
  data?: {
    user?: {
      edge_owner_to_timeline_media?: {
        edges?: {
          node?: WebProfileMediaNode;
        }[];
      };
    };
  };
  status?: string;
}

interface WebProfileMediaNode {
  shortcode?: string;
  is_video?: boolean;
  product_type?: string;
  display_url?: string;
  thumbnail_src?: string;
  edge_media_to_caption?: {
    edges?: {
      node?: {
        text?: string;
      };
    }[];
  };
  edge_sidecar_to_children?: {
    edges?: {
      node?: {
        display_url?: string;
        is_video?: boolean;
        thumbnail_src?: string;
      };
    }[];
  };
}

const POST_LINK_SELECTOR = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';

export class InstagramScraper {
  constructor(
    private readonly logger: Logger,
    private readonly requestTimeoutMs: number,
    private readonly headless: boolean
  ) {}

  async getLatestPost(profileUrl: string): Promise<InstagramPost> {
    const browser = await chromium.launch({ headless: this.headless });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      locale: 'es-ES'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(this.requestTimeoutMs);

    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: this.requestTimeoutMs });
      await page.waitForTimeout(1_000);
      await this.dismissObstructions(page);
      const latestPostUrl = await this.resolveLatestPostUrl(page);

      if (!latestPostUrl) {
        const diagnostics = await this.getProfileDiagnostics(page);
        const fallbackPost = await this.getLatestPostViaWebProfileInfo(context.request, profileUrl);
        if (fallbackPost) {
          this.logger.warn('Using web_profile_info fallback due profile login/challenge', {
            diagnostics
          });
          return fallbackPost;
        }
        throw new ScraperExtractionError(
          `No se pudo encontrar el último post en el perfil. url=${diagnostics.url} title=${diagnostics.title} hints=${diagnostics.hints.join(',') || 'none'}`
        );
      }

      await page.goto(latestPostUrl, { waitUntil: 'domcontentloaded', timeout: this.requestTimeoutMs });
      await page.waitForLoadState('networkidle', { timeout: this.requestTimeoutMs }).catch(() => undefined);
      await this.dismissObstructions(page);

      const raw = await page.evaluate<RawPostExtract>(() => {
        const ogUrl =
          document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content ??
          document.querySelector<HTMLMetaElement>('meta[name="og:url"]')?.content ??
          '';
        const ogTitle =
          document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ??
          document.querySelector<HTMLMetaElement>('meta[name="og:title"]')?.content ??
          '';
        const ogDescription =
          document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content ??
          document.querySelector<HTMLMetaElement>('meta[name="og:description"]')?.content ??
          '';
        const ogImage =
          document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ??
          document.querySelector<HTMLMetaElement>('meta[name="og:image"]')?.content ??
          '';

        const ldImages: string[] = [];
        let ldCaption = '';

        const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'));
        for (const script of scripts) {
          const text = script.textContent;
          if (!text) {
            continue;
          }

          try {
            const parsed = JSON.parse(text) as unknown;
            const stack: unknown[] = [parsed];

            while (stack.length > 0) {
              const current = stack.pop();
              if (Array.isArray(current)) {
                for (const item of current) {
                  stack.push(item);
                }
                continue;
              }

              if (!current || typeof current !== 'object') {
                continue;
              }

              const record = current as Record<string, unknown>;

              if (!ldCaption && typeof record.caption === 'string') {
                ldCaption = record.caption;
              }

              if (!ldCaption && typeof record.description === 'string' && record.description.length > 0) {
                ldCaption = record.description;
              }

              const images = record.image;
              if (Array.isArray(images)) {
                for (const image of images) {
                  if (typeof image === 'string') {
                    ldImages.push(image);
                  }
                }
              } else if (typeof images === 'string') {
                ldImages.push(images);
              }

              for (const nested of Object.values(record)) {
                if (nested && typeof nested === 'object') {
                  stack.push(nested);
                }
              }
            }
          } catch {
            // Ignore invalid JSON-LD blocks.
          }
        }

        const selectors = ['article h1', 'main h1', 'article ul li h1', 'article ul li span'];
        const candidates: string[] = [];

        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
          for (const node of nodes) {
            const text = node.innerText?.trim();
            if (text && text.length > 0) {
              candidates.push(text);
            }
          }
        }

        candidates.sort((a, b) => b.length - a.length);
        const visibleCaption = candidates[0] ?? '';

        return {
          permalink: window.location.href.split('?')[0] ?? '',
          ogUrl,
          ogTitle,
          ogDescription,
          ogImage,
          ldCaption,
          ldImages,
          visibleCaption,
          pathname: window.location.pathname
        };
      });

      const normalizedPermalink = normalizePermalink(raw.permalink || raw.ogUrl || latestPostUrl);
      const shortcode = extractShortcode(normalizedPermalink);
      if (!shortcode) {
        throw new ScraperExtractionError('No se pudo extraer el shortcode del post.');
      }

      const caption = pickCaption(raw);
      const mediaUrls = uniqueUrls([...raw.ldImages, raw.ogImage]);

      const isReel = normalizedPermalink.includes('/reel/') || raw.pathname.includes('/reel/');
      const mediaType: InstagramMediaType = isReel ? 'REEL' : mediaUrls.length > 1 ? 'CAROUSEL' : 'IMAGE';

      const thumbnailUrl = raw.ogImage || mediaUrls[0];
      const finalMediaUrls = mediaUrls.length > 0 ? mediaUrls : thumbnailUrl ? [thumbnailUrl] : [];

      if (finalMediaUrls.length === 0) {
        throw new ScraperExtractionError('No se pudo extraer ninguna URL de media del post.');
      }

      const response: InstagramPost = {
        shortcode,
        permalink: normalizedPermalink,
        caption,
        mediaUrls: finalMediaUrls,
        mediaType
      };
      if (mediaType === 'REEL' && thumbnailUrl) {
        response.thumbnailUrl = thumbnailUrl;
      }

      this.logger.debug('Instagram latest post extracted', {
        permalink: response.permalink,
        shortcode: response.shortcode,
        mediaType: response.mediaType,
        mediaCount: response.mediaUrls.length
      });

      return response;
    } catch (error) {
      if (error instanceof ScraperExtractionError) {
        throw error;
      }

      throw new ScraperExtractionError(`Error al extraer el post más reciente de Instagram: ${getErrorMessage(error)}`, {
        cause: error
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }

  private async getLatestPostViaWebProfileInfo(
    request: APIRequestContext,
    profileUrl: string
  ): Promise<InstagramPost | null> {
    const username = extractUsernameFromProfileUrl(profileUrl);
    if (!username) {
      return null;
    }

    const endpoint = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    try {
      const response = await request.get(endpoint, {
        timeout: this.requestTimeoutMs,
        headers: {
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
          referer: normalizeProfileUrl(profileUrl),
          'x-ig-app-id': '936619743392459',
          'x-asbd-id': '129477',
          'x-ig-www-claim': '0',
          accept: 'application/json'
        }
      });

      if (!response.ok()) {
        this.logger.warn('web_profile_info fallback failed', {
          status: response.status(),
          username
        });
        return null;
      }

      const payload = (await response.json()) as WebProfileInfoResponse;
      const firstNode = payload.data?.user?.edge_owner_to_timeline_media?.edges?.[0]?.node;

      if (!firstNode?.shortcode) {
        return null;
      }

      const caption = firstNode.edge_media_to_caption?.edges?.[0]?.node?.text?.trim() ?? '';
      const shortcode = firstNode.shortcode;
      const mediaType = inferMediaType(firstNode);
      const mediaUrls = extractMediaUrlsFromNode(firstNode, mediaType);
      const permalink = buildPermalink(shortcode, mediaType);

      if (mediaUrls.length === 0) {
        return null;
      }

      const result: InstagramPost = {
        shortcode,
        permalink,
        caption,
        mediaUrls,
        mediaType
      };

      if (mediaType === 'REEL') {
        const thumbnail = firstNode.thumbnail_src ?? firstNode.display_url ?? mediaUrls[0];
        if (thumbnail) {
          result.thumbnailUrl = thumbnail;
        }
      }

      return result;
    } catch (error) {
      this.logger.warn('web_profile_info request failed', {
        username,
        error: getErrorMessage(error)
      });
      return null;
    }
  }

  private async dismissObstructions(page: Page): Promise<void> {
    await page.keyboard.press('Escape').catch(() => undefined);

    const buttonLabels = [
      'Permitir solo cookies esenciales',
      'Aceptar todas las cookies',
      'Allow all cookies',
      'Only allow essential cookies',
      'Ahora no',
      'Not now'
    ];

    for (const label of buttonLabels) {
      await page
        .getByRole('button', { name: label, exact: false })
        .first()
        .click({ timeout: 1_000 })
        .catch(() => undefined);
    }
  }

  private async resolveLatestPostUrl(page: Page): Promise<string | null> {
    await page.waitForSelector(POST_LINK_SELECTOR, { timeout: Math.min(7_000, this.requestTimeoutMs) }).catch(() => undefined);

    const fromDom = await page.evaluate((selector) => {
      const selectors = [selector, 'a[href*="/p/"]', 'a[href*="/reel/"]'];
      for (const currentSelector of selectors) {
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(currentSelector));
        for (const link of links) {
          const href = link.getAttribute('href');
          if (!href) {
            continue;
          }

          const directAbsolute = /^https?:\/\/www\.instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/?/i.exec(href);
          if (directAbsolute?.[0]) {
            return directAbsolute[0];
          }

          const pathMatch = /\/(?:p|reel)\/[A-Za-z0-9_-]+\/?/.exec(href);
          if (pathMatch?.[0]) {
            return new URL(pathMatch[0], 'https://www.instagram.com').toString();
          }
        }
      }

      return null;
    }, POST_LINK_SELECTOR);

    if (fromDom) {
      return normalizePermalink(fromDom);
    }

    const html = await page.content();
    const fromHtml = extractPostUrlFromHtml(html);
    if (fromHtml) {
      this.logger.warn('Instagram post link extracted from HTML fallback');
      return normalizePermalink(fromHtml);
    }

    return null;
  }

  private async getProfileDiagnostics(page: Page): Promise<{ url: string; title: string; hints: string[] }> {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const bodyText = (await page.textContent('body').catch(() => '')) ?? '';
    const normalized = bodyText.replace(/\s+/g, ' ').toLowerCase();

    const hints: string[] = [];
    if (url.includes('/accounts/login')) {
      hints.push('redirect-login');
    }
    if (normalized.includes('inicia sesión') || normalized.includes('log in')) {
      hints.push('login-wall');
    }
    if (normalized.includes('something went wrong') || normalized.includes('algo salió mal')) {
      hints.push('error-page');
    }
    if (normalized.includes('challenge')) {
      hints.push('challenge');
    }

    return { url, title, hints };
  }
}

function pickCaption(raw: RawPostExtract): string {
  const fromLd = sanitizeCaption(raw.ldCaption);
  if (fromLd) {
    return fromLd;
  }

  const fromVisible = sanitizeCaption(raw.visibleCaption);
  if (fromVisible) {
    return fromVisible;
  }

  const fromOgTitle = sanitizeCaption(extractQuotedCaption(raw.ogTitle));
  if (fromOgTitle) {
    return fromOgTitle;
  }

  return sanitizeCaption(extractQuotedCaption(raw.ogDescription)) ?? '';
}

function sanitizeCaption(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

function extractQuotedCaption(value: string): string {
  const quoted = /["“](.*?)["”]/.exec(value);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  return '';
}

function normalizePermalink(value: string): string {
  const normalized = value.split('?')[0]?.trim() ?? value.trim();
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
  }

  const path = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `https://www.instagram.com${path.endsWith('/') ? path : `${path}/`}`;
}

function extractShortcode(permalink: string): string | null {
  const match = /\/(p|reel)\/([A-Za-z0-9_-]+)/.exec(permalink);
  return match?.[2] ?? null;
}

function extractUsernameFromProfileUrl(profileUrl: string): string | null {
  try {
    const parsed = new URL(profileUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments[0] ?? null;
  } catch {
    return null;
  }
}

function normalizeProfileUrl(profileUrl: string): string {
  const username = extractUsernameFromProfileUrl(profileUrl);
  if (!username) {
    return profileUrl;
  }
  return `https://www.instagram.com/${username}/`;
}

function inferMediaType(node: WebProfileMediaNode): InstagramMediaType {
  const isReel = node.is_video ?? node.product_type === 'clips';
  if (isReel) {
    return 'REEL';
  }

  const childCount = node.edge_sidecar_to_children?.edges?.length ?? 0;
  if (childCount > 1) {
    return 'CAROUSEL';
  }

  return 'IMAGE';
}

function extractMediaUrlsFromNode(node: WebProfileMediaNode, mediaType: InstagramMediaType): string[] {
  if (mediaType === 'CAROUSEL') {
    const carouselUrls =
      node.edge_sidecar_to_children?.edges
        ?.map((edge) => edge.node?.display_url ?? edge.node?.thumbnail_src ?? '')
        .filter((url) => Boolean(url)) ?? [];

    if (carouselUrls.length > 0) {
      return uniqueUrls(carouselUrls);
    }
  }

  const primary = node.display_url ?? node.thumbnail_src ?? '';
  return primary ? [primary] : [];
}

function buildPermalink(shortcode: string, mediaType: InstagramMediaType): string {
  if (mediaType === 'REEL') {
    return `https://www.instagram.com/reel/${shortcode}/`;
  }
  return `https://www.instagram.com/p/${shortcode}/`;
}

function extractPostUrlFromHtml(html: string): string | null {
  const directUrlMatch = /https?:\/\/www\.instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/?/i.exec(html);
  if (directUrlMatch?.[0]) {
    return directUrlMatch[0];
  }

  const plainPathMatch = /\/(?:p|reel)\/[A-Za-z0-9_-]+\/?/.exec(html);
  if (plainPathMatch?.[0]) {
    return `https://www.instagram.com${plainPathMatch[0]}`;
  }

  const escapedPathMatch = /\\\/(?:p|reel)\\\/[A-Za-z0-9_-]+\\\/?/.exec(html);
  if (escapedPathMatch?.[0]) {
    const unescapedPath = escapedPathMatch[0].replace(/\\\//g, '/');
    return `https://www.instagram.com${unescapedPath}`;
  }

  return null;
}

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const url of urls) {
    const normalized = url.trim();
    if (!normalized || !/^https?:\/\//i.test(normalized)) {
      continue;
    }

    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
