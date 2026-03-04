import axios from 'axios';
import cron, { type ScheduledTask } from 'node-cron';
import type { GeminiClient } from '../ai/gemini';
import type { StateStore } from '../db/state';
import type { FacebookPublisher } from '../publisher/facebook';
import type { InstagramScraper, InstagramPost } from '../scraper/instagramScraper';
import type { ThreadsScraper } from '../scraper/threadsScraper';
import type { R2Storage } from '../storage/r2';
import { sha256 } from '../utils/hash';
import type { Logger } from '../utils/logger';
import { retry } from '../utils/retry';

export interface PollerConfig {
  profileUrl: string;
  threadsProfileUrl?: string;
  enableThreadsFallback: boolean;
  pollMinutes: number;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  facebookPageId: string;
  facebookPageAccessToken: string;
}

export interface PollerDependencies {
  scraper: InstagramScraper;
  threadsScraper?: ThreadsScraper;
  stateStore: StateStore;
  r2: R2Storage;
  gemini: GeminiClient;
  facebook: FacebookPublisher;
  logger: Logger;
}

type SourceKind = 'instagram' | 'threads';

interface SourcedPost extends InstagramPost {
  source: SourceKind;
  sourceProfileUrl: string;
}

interface DownloadedMedia {
  buffer: Buffer;
  contentType: string;
}

export class Poller {
  private task: ScheduledTask | null = null;
  private isRunning = false;

  constructor(private readonly config: PollerConfig, private readonly deps: PollerDependencies) {}

  start(): void {
    const expression = `*/${this.config.pollMinutes} * * * *`;

    this.task = cron.schedule(expression, () => {
      void this.runTick();
    });

    this.deps.logger.info('Poller started', {
      cron: expression,
      profileUrl: this.config.profileUrl
    });

    void this.runTick();
  }

  async stop(): Promise<void> {
    if (this.task) {
      await this.task.stop();
      await this.task.destroy();
      this.task = null;
    }

    this.deps.logger.info('Poller stopped');
  }

  async runTick(): Promise<void> {
    if (this.isRunning) {
      this.deps.logger.warn('Poll cycle skipped because a previous cycle is still running');
      return;
    }

    this.isRunning = true;
    const startedAt = Date.now();
    let permalinkForLog: string | undefined;
    let shortcodeForLog: string | undefined;
    let sourceForLog: SourceKind | undefined;

    try {
      const latestPost = await this.getLatestPostWithFallback();

      permalinkForLog = latestPost.permalink;
      shortcodeForLog = latestPost.shortcode;
      sourceForLog = latestPost.source;

      const captionHash = sha256(latestPost.caption);
      const alreadyProcessed = this.deps.stateStore.isProcessed(latestPost.permalink, captionHash);

      if (alreadyProcessed) {
        const durationMs = Date.now() - startedAt;
        this.deps.logger.info('Post unchanged. Nothing to do.', {
          permalink: latestPost.permalink,
          shortcode: latestPost.shortcode,
          source: latestPost.source,
          captionHash,
          durationMs
        });

        await this.deps.stateStore.appendRunLog({
          runAt: new Date().toISOString(),
          durationMs,
          status: 'skipped',
          permalink: latestPost.permalink,
          shortcode: latestPost.shortcode,
          detail: `Deduplicated (${latestPost.source} same permalink + caption hash).`
        });

        return;
      }

      const primaryMediaUrl = selectPrimaryMediaUrl(latestPost);
      const downloaded = await this.withRetry('media.download', () =>
        downloadMedia(primaryMediaUrl, this.config.requestTimeoutMs)
      );

      const profileSlug = extractProfileSlug(latestPost.sourceProfileUrl);
      const sourceFolder = latestPost.source === 'threads' ? 'threads' : 'ig';
      const originalKey = `${sourceFolder}/${profileSlug}/${latestPost.shortcode}/original.jpg`;
      const viralKey = `${sourceFolder}/${profileSlug}/${latestPost.shortcode}/viral.jpg`;

      await this.withRetry('r2.upload.original', () =>
        this.deps.r2.uploadBuffer(originalKey, downloaded.buffer, downloaded.contentType)
      );

      const viralCopy = await this.withRetry('gemini.generateViralCopy', () =>
        this.deps.gemini.generateViralCopy(latestPost.caption, latestPost.permalink)
      );

      const viralImageBuffer = await this.withRetry('gemini.generateViralImage', () =>
        this.deps.gemini.generateViralImage(downloaded.buffer, latestPost.caption)
      );

      await this.withRetry('r2.upload.viral', () =>
        this.deps.r2.uploadBuffer(viralKey, viralImageBuffer, detectImageMimeFromBuffer(viralImageBuffer))
      );

      const viralPublicUrl = this.deps.r2.getPublicUrl(viralKey);
      const publishResult = await this.withRetry('facebook.publishPhotoToPage', () =>
        this.deps.facebook.publishPhotoToPage(
          this.config.facebookPageId,
          this.config.facebookPageAccessToken,
          viralPublicUrl,
          viralCopy
        )
      );

      const durationMs = Date.now() - startedAt;
      await this.deps.stateStore.markProcessed({
        permalink: latestPost.permalink,
        captionHash,
        shortcode: latestPost.shortcode,
        facebookPostId: publishResult.post_id ?? publishResult.id,
        processedAt: new Date().toISOString()
      });

      await this.deps.stateStore.appendRunLog({
        runAt: new Date().toISOString(),
        durationMs,
        status: 'success',
        permalink: latestPost.permalink,
        shortcode: latestPost.shortcode,
        facebookPostId: publishResult.post_id ?? publishResult.id,
        detail: `Published to Facebook Page (source=${latestPost.source}).`
      });

      this.deps.logger.info('Pipeline success', {
        permalink: latestPost.permalink,
        shortcode: latestPost.shortcode,
        source: latestPost.source,
        mediaType: latestPost.mediaType,
        publishPhotoId: publishResult.id,
        publishPostId: publishResult.post_id,
        durationMs
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = getErrorMessage(error);

      this.deps.logger.error('Pipeline failed', {
        error: message,
        permalink: permalinkForLog,
        shortcode: shortcodeForLog,
        source: sourceForLog,
        durationMs
      });

      await this.deps.stateStore.appendRunLog({
        runAt: new Date().toISOString(),
        durationMs,
        status: 'error',
        detail: sourceForLog ? `[${sourceForLog}] ${message}` : message,
        ...(permalinkForLog ? { permalink: permalinkForLog } : {}),
        ...(shortcodeForLog ? { shortcode: shortcodeForLog } : {})
      });
    } finally {
      this.isRunning = false;
    }
  }

  private async withRetry<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
    return retry(operation, {
      retries: this.config.maxRetries,
      baseDelayMs: this.config.retryBaseDelayMs,
      maxDelayMs: this.config.retryMaxDelayMs,
      timeoutMs: this.config.requestTimeoutMs,
      operationName,
      onRetry: ({ attempt, remainingRetries, delayMs, error }) => {
        this.deps.logger.warn('Retry scheduled', {
          operationName,
          attempt,
          remainingRetries,
          delayMs,
          error: getErrorMessage(error)
        });
      }
    });
  }

  private async getLatestPostWithFallback(): Promise<SourcedPost> {
    try {
      const instagramPost = await this.withRetry('instagram.getLatestPost', () =>
        this.deps.scraper.getLatestPost(this.config.profileUrl)
      );

      return {
        ...instagramPost,
        source: 'instagram',
        sourceProfileUrl: this.config.profileUrl
      };
    } catch (instagramError) {
      const threadsProfileUrl = this.config.threadsProfileUrl;
      const threadsScraper = this.deps.threadsScraper;
      const canUseThreadsFallback = this.config.enableThreadsFallback && Boolean(threadsProfileUrl) && Boolean(threadsScraper);

      if (!canUseThreadsFallback || !threadsProfileUrl || !threadsScraper) {
        throw instagramError;
      }

      this.deps.logger.warn('Instagram source failed; trying Threads fallback', {
        error: getErrorMessage(instagramError),
        threadsProfileUrl
      });

      const threadsPost = await this.withRetry('threads.getLatestPost', () =>
        threadsScraper.getLatestPost(threadsProfileUrl)
      );

      return {
        ...threadsPost,
        source: 'threads',
        sourceProfileUrl: threadsProfileUrl
      };
    }
  }
}

function selectPrimaryMediaUrl(post: InstagramPost): string {
  if (post.mediaType === 'REEL') {
    return post.thumbnailUrl ?? post.mediaUrls[0] ?? '';
  }

  return post.mediaUrls[0] ?? '';
}

async function downloadMedia(url: string, timeoutMs: number): Promise<DownloadedMedia> {
  if (!url) {
    throw new Error('Primary media URL is empty.');
  }

  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    }
  });

  const contentTypeHeader = typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : undefined;
  const contentType = normalizeContentType(contentTypeHeader ?? inferMimeFromUrl(url));

  return {
    buffer: Buffer.from(response.data),
    contentType
  };
}

function normalizeContentType(contentType: string): string {
  if (contentType.startsWith('image/')) {
    return contentType;
  }
  return 'image/jpeg';
}

function inferMimeFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function detectImageMimeFromBuffer(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  return 'image/jpeg';
}

function extractProfileSlug(profileUrl: string): string {
  const url = new URL(profileUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  return segments[0] ?? 'profile';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
