import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
export interface UploadSigner {
  presignUpload(input: PresignInput): Promise<PresignedUpload>;
}
/** Everything the scanner worker needs on top of signing. */
export interface ObjectStore extends UploadSigner {
  /** Size of the stored object, or null when it does not exist. */
  head(bucket: string, key: string): Promise<{ size: number } | null>;
  /** Reads a whole object; throws when it is larger than maxBytes. */
  get(bucket: string, key: string, maxBytes: number): Promise<Buffer>;
  put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
  delete(bucket: string, key: string): Promise<void>;
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
    async head(bucket, key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: out.ContentLength ?? 0 };
      } catch (error) {
        const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async get(bucket, key, maxBytes) {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if ((out.ContentLength ?? 0) > maxBytes) throw new Error('object larger than limit');
      return Buffer.from(await out.Body!.transformToByteArray());
    },
    async put(bucket, key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async delete(bucket, key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
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
