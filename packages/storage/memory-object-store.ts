/**
 * Phase 5 — in-memory ObjectStore for UNIT tests and local classification ONLY.
 *
 * CLASSIFICATION (environment matrix, docs/vaulltcore/phase5/infrastructure.md):
 *   TEST-ONLY. Never used by production code paths. Real-infrastructure gates
 *   always construct R2ObjectStore from real credentials instead.
 *
 * Supports injectable failure hooks so failure-injection tests can exercise
 * DB/object divergence without touching a provider.
 */

import {
  clampExpiry,
  type CreateDownloadUrlInput,
  type CreateUploadUrlInput,
  type GetObjectResult,
  type ObjectBody,
  type ObjectHead,
  type ObjectStore,
  type PresignedDownload,
  type PresignedUpload,
  type PutObjectInput,
} from "./object-store";

export interface MemoryFailureHooks {
  failPutOnce?: boolean;
  failGetOnce?: boolean;
  failHeadOnce?: boolean;
  failDeleteOnce?: boolean;
}

interface StoredObject {
  body: Uint8Array;
  head: ObjectHead;
}

export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();
  public failures: MemoryFailureHooks = {};

  async put(input: PutObjectInput): Promise<ObjectHead> {
    if (this.failures.failPutOnce) {
      this.failures.failPutOnce = false;
      throw new Error("injected put failure");
    }
    const body = encode(input.body);
    const head: ObjectHead = {
      key: input.key,
      byteSize: body.byteLength,
      contentType: input.contentType,
      etag: `"mem-${Date.now()}"`,
      metadata: input.metadata,
    };
    this.objects.set(input.key, { body, head });
    return head;
  }

  async get(key: string): Promise<GetObjectResult | null> {
    if (this.failures.failGetOnce) {
      this.failures.failGetOnce = false;
      throw new Error("injected get failure");
    }
    const stored = this.objects.get(key);
    if (!stored) return null;
    return { ...stored.head, body: stored.body };
  }

  async head(key: string): Promise<ObjectHead | null> {
    if (this.failures.failHeadOnce) {
      this.failures.failHeadOnce = false;
      throw new Error("injected head failure");
    }
    return this.objects.get(key)?.head ?? null;
  }

  async delete(key: string): Promise<void> {
    if (this.failures.failDeleteOnce) {
      this.failures.failDeleteOnce = false;
      throw new Error("injected delete failure");
    }
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload> {
    const expiresInSec = clampExpiry(input.expiresInSec);
    return {
      url: `memory://upload/${input.key}?exp=${expiresInSec}`,
      method: "PUT",
      expiresInSec,
      requiredHeaders: { "Content-Type": input.contentType },
    };
  }

  async createDownloadUrl(
    input: CreateDownloadUrlInput,
  ): Promise<PresignedDownload> {
    const expiresInSec = clampExpiry(input.expiresInSec);
    return {
      url: `memory://download/${input.key}?exp=${expiresInSec}`,
      method: "GET",
      expiresInSec,
    };
  }
}

function encode(body: ObjectBody): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}
