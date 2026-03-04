import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ExternalServiceError } from '../utils/errors';
import type { Logger } from '../utils/logger';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  publicBaseUrl: string;
}

export class R2Storage {
  private readonly client: S3Client;

  constructor(private readonly config: R2Config, private readonly logger: Logger) {
    this.client = new S3Client({
      region: config.region,
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    });
  }

  async uploadBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: normalizeKey(key),
          Body: body,
          ContentType: contentType
        })
      );

      this.logger.info('R2 upload complete', {
        bucket: this.config.bucket,
        key: normalizeKey(key),
        contentType,
        sizeBytes: body.length
      });
    } catch (error) {
      throw new ExternalServiceError(`R2 upload failed for key ${key}`, { cause: error });
    }
  }

  getPublicUrl(key: string): string {
    const normalizedKey = normalizeKey(key);
    return new URL(normalizedKey, this.config.publicBaseUrl).toString();
  }
}

function normalizeKey(key: string): string {
  return key.replace(/^\/+/, '');
}
