/**
 * Phase 5 — Cloudflare R2 adapter over the S3-compatible API.
 *
 * LAYER 2 (ADAPTER). This is the ONLY file in the repository that imports
 * AWS SDK / R2-specific client code. Server-side runtimes (Node/Bun/Fly)
 * use this; a future Worker deployment would implement ObjectStore over the
 * native R2 binding instead — never both in one runtime path.
 *
 * Security properties:
 *  - presigned PUTs bind Content-Type into the signature
 *  - presign expirations are clamped to [30s, 900s]
 *  - credentials are read from env once and never logged
 *  - delete() is idempotent (R2/S3 DELETE on missing key returns success)
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  clampExpiry,
  MAX_ARTIFACT_BYTES,
  type CreateDownloadUrlInput,
  type CreateUploadUrlInput,
  type GetObjectResult,
  type ObjectHead,
  type ObjectStore,
  type PresignedDownload,
  type PresignedUpload,
  type PutObjectInput,
} from "../object-store";
import { readR2Config, type R2Config } from "./config";

export class R2ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: R2Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  static fromEnv(
    env: Record<string, string | undefined> = process.env,
  ): R2ObjectStore {
    return new R2ObjectStore(readR2Config(env));
  }

  async put(input: PutObjectInput): Promise<ObjectHead> {
    const body =
      typeof input.body === "string"
        ? new TextEncoder().encode(input.body)
        : input.body;
    if (body.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error(`object exceeds MAX_ARTIFACT_BYTES (${MAX_ARTIFACT_BYTES})`);
    }
    const out = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: body,
        ContentType: input.contentType,
        Metadata: input.metadata,
      }),
    );
    return {
      key: input.key,
      byteSize: body.byteLength,
      contentType: input.contentType,
      etag: out.ETag,
    };
  }

  async get(key: string): Promise<GetObjectResult | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await out.Body?.transformToByteArray();
      if (!bytes) return null;
      return {
        key,
        byteSize: bytes.byteLength,
        contentType: out.ContentType,
        etag: out.ETag,
        lastModified: out.LastModified?.toISOString(),
        metadata: normalizeMetadata(out.Metadata),
        body: bytes,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        key,
        byteSize: out.ContentLength ?? 0,
        contentType: out.ContentType,
        etag: out.ETag,
        lastModified: out.LastModified?.toISOString(),
        metadata: normalizeMetadata(out.Metadata),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Idempotent by contract: S3/R2 DELETE of a missing key succeeds. */
  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async createUploadUrl(
    input: CreateUploadUrlInput,
  ): Promise<PresignedUpload> {
    const expiresInSec = clampExpiry(input.expiresInSec);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: expiresInSec });
    return {
      url,
      method: "PUT",
      expiresInSec,
      requiredHeaders: { "Content-Type": input.contentType },
    };
  }

  async createDownloadUrl(
    input: CreateDownloadUrlInput,
  ): Promise<PresignedDownload> {
    const expiresInSec = clampExpiry(input.expiresInSec);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: expiresInSec });
    return { url, method: "GET", expiresInSec };
  }
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? "";
  const meta = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || meta === 404;
}

function normalizeMetadata(
  meta: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!meta || Object.keys(meta).length === 0) return undefined;
  return meta;
}
