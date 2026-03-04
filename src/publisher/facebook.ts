import axios, { AxiosError, type AxiosInstance } from 'axios';
import { ExternalServiceError } from '../utils/errors';
import type { Logger } from '../utils/logger';

export interface FacebookConfig {
  graphVersion: string;
  timeoutMs: number;
}

interface FacebookPhotoUploadResponse {
  id: string;
  post_id?: string;
}

interface FacebookFeedPublishResponse {
  id: string;
  post_id?: string;
  permalink_url?: string;
}

export interface FacebookPublishResult {
  id: string;
  post_id?: string;
  permalink_url?: string;
  photo_id?: string;
}

interface ParsedFacebookError {
  status?: number;
  message: string;
  graphError?: unknown;
  retryable: boolean;
  hint?: string;
}

interface GraphErrorPayload {
  message?: string;
  code?: number;
  is_transient?: boolean;
}

export class FacebookPublisher {
  private readonly http: AxiosInstance;

  constructor(private readonly config: FacebookConfig, private readonly logger: Logger) {
    this.http = axios.create({
      baseURL: 'https://graph.facebook.com',
      timeout: config.timeoutMs,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
  }

  async publishPhotoToPage(
    pageId: string,
    pageAccessToken: string,
    imageUrl: string,
    caption: string
  ): Promise<FacebookPublishResult> {
    try {
      const photoId = await this.uploadPhotoUnpublished(pageId, pageAccessToken, imageUrl);
      const feedPost = await this.createFeedPostWithAttachedMedia(pageId, pageAccessToken, photoId, caption);

      let permalinkUrl = feedPost.permalink_url;
      permalinkUrl ??= await this.getPostPermalink(feedPost.id, pageAccessToken).catch((error) => {
        this.logger.warn('Could not fetch Facebook post permalink', {
          postId: feedPost.id,
          error: getErrorMessage(error)
        });
        return undefined;
      });

      const result: FacebookPublishResult = {
        id: feedPost.id,
        post_id: feedPost.post_id ?? feedPost.id,
        photo_id: photoId
      };
      if (permalinkUrl) {
        result.permalink_url = permalinkUrl;
      }

      this.logger.info('Facebook post published (two-step: photos -> feed)', {
        pageId,
        photoId,
        postId: result.post_id,
        permalinkUrl: result.permalink_url
      });

      return result;
    } catch (error) {
      throw this.toExternalServiceError(error, {
        action: 'publish post with attached photo',
        pageId
      });
    }
  }

  private async uploadPhotoUnpublished(pageId: string, pageAccessToken: string, imageUrl: string): Promise<string> {
    const endpoint = `/${this.config.graphVersion}/${pageId}/photos`;
    const body = new URLSearchParams({
      url: imageUrl,
      published: 'false',
      access_token: pageAccessToken
    });

    try {
      const response = await this.http.post<FacebookPhotoUploadResponse>(endpoint, body.toString());
      this.logger.info('Facebook photo uploaded (published=false)', {
        pageId,
        endpoint,
        photoId: response.data.id
      });
      return response.data.id;
    } catch (error) {
      throw this.toExternalServiceError(error, {
        action: 'upload photo unpublished',
        pageId,
        endpoint
      });
    }
  }

  private async createFeedPostWithAttachedMedia(
    pageId: string,
    pageAccessToken: string,
    photoId: string,
    message: string
  ): Promise<FacebookFeedPublishResponse> {
    const endpoint = `/${this.config.graphVersion}/${pageId}/feed`;
    const body = new URLSearchParams({
      message,
      attached_media: JSON.stringify([{ media_fbid: photoId }]),
      access_token: pageAccessToken
    });

    try {
      const response = await this.http.post<FacebookFeedPublishResponse>(endpoint, body.toString());
      this.logger.info('Facebook feed post created with attached media', {
        pageId,
        endpoint,
        photoId,
        postId: response.data.id
      });
      return response.data;
    } catch (error) {
      throw this.toExternalServiceError(error, {
        action: 'create feed post with attached media',
        pageId,
        endpoint,
        photoId
      });
    }
  }

  private async getPostPermalink(postId: string, pageAccessToken: string): Promise<string | undefined> {
    const endpoint = `/${this.config.graphVersion}/${postId}`;

    const response = await this.http.get<{ id: string; permalink_url?: string }>(endpoint, {
      params: {
        access_token: pageAccessToken,
        fields: 'id,permalink_url'
      }
    });

    return response.data.permalink_url;
  }

  private toExternalServiceError(error: unknown, context: Record<string, unknown>): ExternalServiceError {
    const parsed = parseFacebookError(error);

    this.logger.error('Facebook API request failed', {
      ...context,
      status: parsed.status,
      errorMessage: parsed.message,
      hint: parsed.hint,
      graphError: parsed.graphError,
      retryable: parsed.retryable
    });

    const fullMessage = parsed.hint ? `${parsed.message}. ${parsed.hint}` : parsed.message;

    const serviceError = new ExternalServiceError(`Facebook Graph API error: ${fullMessage}`, {
      cause: error
    }) as ExternalServiceError & { retryable?: boolean };

    if (!parsed.retryable) {
      serviceError.retryable = false;
    }

    return serviceError;
  }
}

function parseFacebookError(error: unknown): ParsedFacebookError {
  if (error instanceof AxiosError) {
    const responseData: unknown = error.response?.data;
    const graphError = extractGraphError(responseData);

    const parsed: ParsedFacebookError = {
      message: graphError?.message ?? error.response?.statusText ?? error.message,
      retryable: true
    };

    if (typeof error.response?.status === 'number') {
      parsed.status = error.response.status;
    }

    if (responseData !== undefined) {
      parsed.graphError = responseData;
    }

    const normalizedMessage = parsed.message.toLowerCase();
    const code = graphError?.code;
    const status = parsed.status;

    const tokenExpired = code === 190 || normalizedMessage.includes('expired') || normalizedMessage.includes('session has expired');
    const permissionsError =
      code === 200 ||
      normalizedMessage.includes('publish_actions') ||
      normalizedMessage.includes('not allowed to publish') ||
      normalizedMessage.includes('permissions error');
    const invalidImage = code === 100 && normalizedMessage.includes('invalid parameter');

    if (tokenExpired) {
      parsed.retryable = false;
      parsed.hint =
        'El token de Facebook expiró. Renueva FB_PAGE_ACCESS_TOKEN con un Page Access Token válido y de larga duración.';
      return parsed;
    }

    if (permissionsError) {
      parsed.retryable = false;
      parsed.hint =
        'El token no tiene permisos de publicación para Pages. Usa un Page Access Token con pages_manage_posts y app en modo Live.';
      return parsed;
    }

    if (invalidImage) {
      parsed.retryable = false;
      parsed.hint =
        'Imagen inválida para Facebook. Verifica formato soportado (JPG/PNG/GIF/WebP/HEIF/TIFF) y tamaño menor a 10MB.';
      return parsed;
    }

    const transientByGraph = graphError?.is_transient === true;
    const rateLimited = status === 429 || code === 4;
    const serverError = typeof status === 'number' && status >= 500;
    const clientError = typeof status === 'number' && status >= 400 && status < 500;

    parsed.retryable = transientByGraph || rateLimited || serverError;
    if (clientError && !parsed.retryable) {
      parsed.retryable = false;
    }

    return parsed;
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      retryable: true
    };
  }

  return {
    message: String(error),
    retryable: true
  };
}

function extractGraphError(payload: unknown): GraphErrorPayload | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const root = payload as Record<string, unknown>;
  const errorValue = root.error;
  if (!errorValue || typeof errorValue !== 'object') {
    return undefined;
  }

  const errorRecord = errorValue as Record<string, unknown>;
  const parsed: GraphErrorPayload = {};

  if (typeof errorRecord.message === 'string') {
    parsed.message = errorRecord.message;
  }
  if (typeof errorRecord.code === 'number') {
    parsed.code = errorRecord.code;
  }
  if (typeof errorRecord.is_transient === 'boolean') {
    parsed.is_transient = errorRecord.is_transient;
  }

  return parsed;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
