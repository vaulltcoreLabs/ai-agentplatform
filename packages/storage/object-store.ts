/**
 * Phase 5 — provider-neutral object storage contract.
 *
 * LAYER 1 (CONTRACT). This module defines WHAT the platform needs from an
 * object store (R2 today, potentially S3/GCS later). It must never import a
 * provider SDK. Provider-specific code lives in `r2/` only.
 *
 * ROLE BOUNDARY (docs/vaulltcore/phase5/storage-contract.md):
 *   PostgreSQL → authoritative metadata, ownership, authorization, lifecycle.
 *   ObjectStore → opaque bytes for tenant-scoped keys.
 *
 * The object store is NOT a database: no listing-based authorization, no
 * query semantics, no source of truth for jobs/runs/leases/fencing.
 */

/** Maximum accepted upload size (256 MiB) — cost-control bound. */
export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

/** Shortest practical presign expirations are chosen by callers; these bound them. */
export const MIN_PRESIGN_EXPIRY_SEC = 30;
export const MAX_PRESIGN_EXPIRY_SEC = 900;

export type ObjectBody = Uint8Array | string;

export interface PutObjectInput {
  /** Server-constructed, tenant-scoped key. Never client-supplied raw. */
  readonly key: string;
  readonly body: ObjectBody;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

export interface ObjectHead {
  readonly key: string;
  readonly byteSize: number;
  readonly contentType?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly metadata?: Record<string, string>;
}

export interface GetObjectResult extends ObjectHead {
  readonly body: Uint8Array;
}

export interface PresignedUpload {
  readonly url: string;
  readonly method: "PUT";
  readonly expiresInSec: number;
  /** Headers the client MUST send; content-type is bound into the signature. */
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface PresignedDownload {
  readonly url: string;
  readonly method: "GET";
  readonly expiresInSec: number;
}

export interface CreateUploadUrlInput {
  readonly key: string;
  readonly contentType: string;
  readonly expiresInSec: number;
}

export interface CreateDownloadUrlInput {
  readonly key: string;
  readonly expiresInSec: number;
}

/**
 * Provider-neutral object storage contract.
 *
 * All methods take server-authoritative keys. Implementations must never
 * derive authorization from key structure — that is PostgreSQL's job.
 */
export interface ObjectStore {
  put(input: PutObjectInput): Promise<ObjectHead>;
  get(key: string): Promise<GetObjectResult | null>;
  head(key: string): Promise<ObjectHead | null>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload>;
  createDownloadUrl(input: CreateDownloadUrlInput): Promise<PresignedDownload>;
}

// ---------------------------------------------------------------------------
// Tenant-scoped key construction (server-side only)
// ---------------------------------------------------------------------------

function assertSegment(name: string, value: string): string {
  if (!value || value.includes("/") || value.includes("..")) {
    throw new Error(`invalid ${name} segment for object key`);
  }
  return value;
}

/**
 * Construct the canonical tenant-scoped artifact key:
 *   tenants/{tenantId}/runs/{runId}/artifacts/{artifactId}
 *
 * Every segment is validated server-side; clients can never choose the
 * tenant/run/artifact path components directly.
 */
export function artifactObjectKey(parts: {
  tenantId: string;
  runId: string;
  artifactId: string;
}): string {
  const tenantId = assertSegment("tenantId", parts.tenantId);
  const runId = assertSegment("runId", parts.runId);
  const artifactId = assertSegment("artifactId", parts.artifactId);
  return `tenants/${tenantId}/runs/${runId}/artifacts/${artifactId}`;
}

export function clampExpiry(expiresInSec: number): number {
  return Math.min(Math.max(expiresInSec, MIN_PRESIGN_EXPIRY_SEC), MAX_PRESIGN_EXPIRY_SEC);
}
