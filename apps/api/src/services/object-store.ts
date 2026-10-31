import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface PresignInput {
  bucket: string;
  key: string;
  contentType: string;
  contentLength: number;
  expiresInSeconds: number;
}
export interface PresignedUpload {
  url: string;
  method: 'PUT';
  /** The upload must send exactly these headers (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: Date;
}
export interface ObjectStore {
  presignUpload(input: PresignInput): Promise<PresignedUpload>;
}

export interface S3Settings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// Vendor claim to verify before real use: R2 is S3-compatible at https://<account>.r2.cloudflarestorage.com,
// region "auto", and enforces signed content-type / content-length on presigned PUTs.
export function createS3ObjectStore(settings: S3Settings): ObjectStore {
  const client = new S3Client({
    region: 'auto',
    forcePathStyle: true, // bucket stays in the path, not the host name
    endpoint: `https://${settings.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
  });
  return {
    async presignUpload(input) {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          ContentType: input.contentType,
          ContentLength: input.contentLength,
        }),
        {
          expiresIn: input.expiresInSeconds,
          signableHeaders: new Set(['content-type', 'content-length']),
        },
      );
      return {
        url,
        method: 'PUT',
        headers: { 'content-type': input.contentType },
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      };
    },
  };
}
