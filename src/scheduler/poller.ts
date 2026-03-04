import axios from 'axios';
import cron, { type ScheduledTask } from 'node-cron';
import type { GeminiClient } from '../ai/gemini';
import type { StateStore } from '../db/state';
import type { FacebookPublisher } from '../publisher/facebook';
import type { InstagramScraper, InstagramPost } from '../scraper/instagramScraper';
import type { ThreadsScraper } from '../scraper/threadsScraper';
import type { R2Storage } from '../storage/r2';
import type { Logger } from '../utils/logger';
import { retry } from '../utils/retry';

export interface PollerTarget {
  instagramUrl: string;
  threadsUrl?: string;
}

export interface PollerConfig {
  targets: PollerTarget[];
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

interface SelectedPost {
  post: SourcedPost;
  bucketFolderKey: string;
  sourceFolder: 'ig' | 'threads';
  profileSlug: string;
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
    const enforcedMinutes = 30;
    if (this.config.pollMinutes !== enforcedMinutes) {
      this.deps.logger.warn('POLL_MINUTES is overridden by business rule to 30 minutes', {
        requestedPollMinutes: this.config.pollMinutes,
        enforcedPollMinutes: enforcedMinutes
      });
    }

    const expression = '*/30 * * * *';

    this.task = cron.schedule(expression, () => {
      void this.runTick();
    });

    this.deps.logger.info('Poller started', {
      cron: expression,
      targets: this.config.targets
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

    let selectedForLog: SelectedPost | null = null;

    try {
      const selected = await this.selectNextNewPost();
      if (!selected) {
        const durationMs = Date.now() - startedAt;
        this.deps.logger.info('No new posts detected in configured targets. Cycle skipped.', {
          targets: this.config.targets,
          durationMs
        });

        await this.deps.stateStore.appendRunLog({
          runAt: new Date().toISOString(),
          durationMs,
          status: 'skipped',
          detail: 'No new posts in configured targets.'
        });

        return;
      }

      selectedForLog = selected;
      const latestPost = selected.post;

      const primaryMediaUrl = selectPrimaryMediaUrl(latestPost);
      const downloaded = await this.withRetry('media.download', () =>
        downloadMedia(primaryMediaUrl, this.config.requestTimeoutMs)
      );

      const originalKey = `${selected.sourceFolder}/${selected.profileSlug}/${latestPost.shortcode}/original.jpg`;
      const viralKey = `${selected.sourceFolder}/${selected.profileSlug}/${latestPost.shortcode}/viral.jpg`;

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
        bucketFolderKey: selected.bucketFolderKey,
        permalink: latestPost.permalink,
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
        detail: `Published to Facebook Page (source=${latestPost.source}, dedupeKey=${selected.bucketFolderKey}).`
      });

      this.deps.logger.info('Pipeline success', {
        permalink: latestPost.permalink,
        shortcode: latestPost.shortcode,
        source: latestPost.source,
        dedupeKey: selected.bucketFolderKey,
        mediaType: latestPost.mediaType,
        publishPhotoId: publishResult.photo_id,
        publishPostId: publishResult.post_id,
        durationMs
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = getErrorMessage(error);

      this.deps.logger.error('Pipeline failed', {
        error: message,
        source: selectedForLog?.post.source,
        permalink: selectedForLog?.post.permalink,
        shortcode: selectedForLog?.post.shortcode,
        dedupeKey: selectedForLog?.bucketFolderKey,
        durationMs
      });

      await this.deps.stateStore.appendRunLog({
        runAt: new Date().toISOString(),
        durationMs,
        status: 'error',
        detail: message,
        ...(selectedForLog?.post.permalink ? { permalink: selectedForLog.post.permalink } : {}),
        ...(selectedForLog?.post.shortcode ? { shortcode: selectedForLog.post.shortcode } : {})
      });
    } finally {
      this.isRunning = false;
    }
  }

  private async selectNextNewPost(): Promise<SelectedPost | null> {
    for (const target of this.config.targets) {
      const targetLabel = extractProfileSlug(target.instagramUrl);

      try {
        const latestPost = await this.getLatestPostWithFallback(target);
        const profileSlug = extractProfileSlug(latestPost.sourceProfileUrl);
        const sourceFolder: 'ig' | 'threads' = latestPost.source === 'threads' ? 'threads' : 'ig';
        const bucketFolderKey = `${sourceFolder}/${profileSlug}/${latestPost.shortcode}`;

        const alreadyProcessed = this.deps.stateStore.isProcessed(bucketFolderKey);
        if (alreadyProcessed) {
          this.deps.logger.info('Target checked with no new post', {
            target: targetLabel,
            source: latestPost.source,
            dedupeKey: bucketFolderKey,
            permalink: latestPost.permalink
          });
          continue;
        }

        this.deps.logger.info('Selected new post from priority list', {
          target: targetLabel,
          source: latestPost.source,
          dedupeKey: bucketFolderKey,
          permalink: latestPost.permalink
        });

        return {
          post: latestPost,
          bucketFolderKey,
          sourceFolder,
          profileSlug
        };
      } catch (error) {
        this.deps.logger.warn('Target check failed. Continuing to next target.', {
          target: targetLabel,
          error: getErrorMessage(error)
        });
      }
    }

    return null;
  }

  private async withRetry<T>(
    operationName: string,
    operation: () => Promise<T>,
    overrides?: {
      retries?: number;
      timeoutMs?: number;
    }
  ): Promise<T> {
    return retry(operation, {
      retries: overrides?.retries ?? this.config.maxRetries,
      baseDelayMs: this.config.retryBaseDelayMs,
      maxDelayMs: this.config.retryMaxDelayMs,
      timeoutMs: overrides?.timeoutMs ?? this.config.requestTimeoutMs,
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

  private async getLatestPostWithFallback(target: PollerTarget): Promise<SourcedPost> {
    const sourceRetries = Math.min(1, this.config.maxRetries);

    try {
      const instagramPost = await this.withRetry(
        'instagram.getLatestPost',
        () => this.deps.scraper.getLatestPost(target.instagramUrl),
        { retries: sourceRetries }
      );

      return {
        ...instagramPost,
        source: 'instagram',
        sourceProfileUrl: target.instagramUrl
      };
    } catch (instagramError) {
      const threadsProfileUrl = target.threadsUrl;
      const threadsScraper = this.deps.threadsScraper;

      if (!threadsProfileUrl || !threadsScraper) {
        throw instagramError;
      }

      this.deps.logger.warn('Instagram source failed; trying Threads fallback', {
        instagramUrl: target.instagramUrl,
        threadsProfileUrl,
        error: getErrorMessage(instagramError)
      });

      const threadsPost = await this.withRetry(
        'threads.getLatestPost',
        () => threadsScraper.getLatestPost(threadsProfileUrl),
        { retries: sourceRetries }
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
  const raw = segments[0] ?? 'profile';
  return raw.replace(/^@/, '').toLowerCase();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
