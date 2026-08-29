/**
 * Phase 5 — Artifact lifecycle service (PROVIDER-NEUTRAL).
 *
 * LAYER 1 (CONTRACT + ORCHESTRATION). This module defines the artifact
 * metadata model and the two-phase lifecycle that keeps PostgreSQL as the
 * AUTHORITATIVE source of truth for ownership/authorization/lifecycle while
 * R2 holds the opaque object body.
 *
 * ROLE BOUNDARY (docs/vaulltcore/phase5/storage-contract.md):
 *   PostgreSQL (ArtifactMetadataStore) → metadata, ownership, authorization,
 *     lifecycle state, SHA-256, size, content-type, object key.
 *   ObjectStore (R2 / memory / future S3) → opaque bytes for a tenant-scoped key.
 *
 * This file MUST NOT import any provider SDK (@aws-sdk, @neondatabase,
 * @cloudflare, drizzle). Provider-specific metadata stores live behind the
 * `ArtifactMetadataStore` interface (e.g. apps/web/lib/db/artifacts.ts for
 * Postgres, the in-memory store below for tests).
 *
 * CORRECTNESS MODEL (no distributed transaction across Postgres + R2):
 *   - Artifact identity is deterministic: given (tenantId, runId, artifactId)
 *     there is exactly ONE logical artifact.
 *   - Reservation is idempotent: re-reserving the same artifactId returns the
 *     existing RESERVED/UPLOADING row; it never creates a second row or a
 *     second object key.
 *   - Confirmation is idempotent: marking READY twice is safe; repeated
 *     confirmation cannot duplicate metadata or create a second object.
 *   - Divergence between metadata and object is repaired by reconciliation,
 *     never assumed away.
 */

import { artifactObjectKey, type ObjectStore } from "./object-store";

/** Lifecycle states. Order matters for state-machine validation. */
export type ArtifactLifecycle =
  | "RESERVED" // metadata row created, no upload yet
  | "UPLOADING" // presigned PUT issued, client may be uploading
  | "READY" // object verified present, artifact downloadable
  | "FAILED" // upload/confirm failed; artifact unusable, retry creates a NEW id
  | "DELETING" // delete requested; R2 delete in progress / pending retry
  | "DELETED"; // R2 object gone, metadata tombstoned

const TERMINAL: ReadonlySet<ArtifactLifecycle> = new Set([
  "READY",
  "FAILED",
  "DELETED",
]);

export interface ArtifactMeta {
  readonly artifactId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly objectKey: string;
  readonly lifecycle: ArtifactLifecycle;
  readonly contentType: string;
  readonly byteSize: number | null;
  readonly sha256: string | null;
  readonly createdAt: string;
  /** RFC3339 of last state transition. */
  readonly updatedAt: string;
  /** When UPLOADING was entered; reconciliation uses this for stalled uploads. */
  readonly uploadedAt: string | null;
  /** Soft-delete marker for DELETED rows. */
  readonly deletedAt: string | null;
}

/**
 * Provider-neutral persistence contract for artifact metadata. Authoritative
 * for ownership and lifecycle. The implementation decides isolation (Postgres
 * WHERE tenant_id = $1, in-memory map keyed by tenant).
 */
export interface ArtifactMetadataStore {
  /** Idempotent reservation. Returns existing row if artifactId already reserved. */
  reserve(input: ReserveInput): Promise<ArtifactMeta>;
  /** Load a specific artifact owned by tenant+run. Null if absent. */
  get(
    tenantId: string,
    runId: string,
    artifactId: string,
  ): Promise<ArtifactMeta | null>;
  /**
   * Transition lifecycle. `expected` is the required current state (fencing).
   * Returns the new row, or null if the current state != expected (lost race
   * / stale worker). Never throws on a benign state mismatch.
   */
  transition(
    input: TransitionInput,
  ): Promise<ArtifactMeta | null>;
  /** List artifacts owned by tenant+run (for reconciliation scans). */
  listByRun(tenantId: string, runId: string): Promise<ArtifactMeta[]>;
  /** List all artifacts owned by tenant (reconciliation over a tenant). */
  listByTenant(tenantId: string): Promise<ArtifactMeta[]>;
  /** Hard delete a metadata row (used after R2 delete succeeds). */
  purge(tenantId: string, runId: string, artifactId: string): Promise<void>;
}

export interface ReserveInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly contentType: string;
}

export interface TransitionInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly expected: ArtifactLifecycle;
  readonly to: ArtifactLifecycle;
  readonly byteSize?: number | null;
  readonly sha256?: string | null;
  readonly objectKey?: string;
}

export interface ReserveArtifactResult {
  readonly meta: ArtifactMeta;
  /** Presigned PUT. Only returned when transitioning into UPLOADING. */
  readonly uploadUrl: import("./object-store").PresignedUpload;
}

export interface ConfirmArtifactResult {
  readonly meta: ArtifactMeta;
}

export interface DownloadArtifactResult {
  readonly meta: ArtifactMeta;
  readonly downloadUrl: import("./object-store").PresignedDownload;
}

export interface ReconcileReport {
  scanned: number;
  repaired: number;
  orphanObjects: string[];
  details: string[];
}

export interface ArtifactServiceConfig {
  /** Grace period before an UPLOADING artifact is considered stalled. */
  readonly uploadingGraceMs: number;
  /** Max presign expiry clamp reused from object-store. */
  readonly presignExpirySec: number;
}

const DEFAULT_CONFIG: ArtifactServiceConfig = {
  uploadingGraceMs: 30 * 60 * 1000,
  presignExpirySec: 900,
};

function nowIso(): string {
  return new Date().toISOString();
}

function assertTenantScoped(tenantId: string, runId: string, artifactId: string): void {
  for (const [name, v] of [
    ["tenantId", tenantId],
    ["runId", runId],
    ["artifactId", artifactId],
  ] as const) {
    if (!v || v.includes("/") || v.includes("..")) {
      throw new Error(`invalid ${name} segment`);
    }
  }
}

/**
 * Orchestrates the artifact lifecycle. Provider-neutral: depends only on the
 * `ArtifactMetadataStore` and `ObjectStore` interfaces.
 */
export class ArtifactService {
  private readonly cfg: ArtifactServiceConfig;

  constructor(
    private readonly metadata: ArtifactMetadataStore,
    private readonly objects: ObjectStore,
    config: Partial<ArtifactServiceConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Phase 16 — upload flow.
   *   authorize (caller already knows tenantId/runId) → reserve metadata →
   *   transition RESERVED→UPLOADING → presigned PUT.
   * Idempotent: re-reserving same artifactId returns existing UPLOADING row
   * and a fresh presigned URL; never a second object.
   */
  async reserveUpload(input: ReserveInput): Promise<ReserveArtifactResult> {
    assertTenantScoped(input.tenantId, input.runId, input.artifactId);
    const existing = await this.metadata.get(
      input.tenantId,
      input.runId,
      input.artifactId,
    );
    let meta = existing;
    if (!meta) {
      meta = await this.metadata.reserve(input);
    } else if (meta.lifecycle === "DELETED") {
      throw new ArtifactError("artifact deleted", "ARTIFACT_DELETED");
    } else if (meta.lifecycle === "FAILED") {
      throw new ArtifactError("artifact failed; create a new id", "ARTIFACT_FAILED");
    }
    // Transition RESERVED -> UPLOADING (idempotent: if already UPLOADING, the
    // transition is a no-op state match and returns the same row).
    const transitioned =
      meta.lifecycle === "UPLOADING"
        ? meta
        : await this.metadata.transition({
            tenantId: input.tenantId,
            runId: input.runId,
            artifactId: input.artifactId,
            expected: "RESERVED",
            to: "UPLOADING",
          });
    if (!transitioned) {
      // Benign race: another worker moved it. Re-read authoritative state.
      const fresh = await this.metadata.get(
        input.tenantId,
        input.runId,
        input.artifactId,
      );
      if (!fresh || (fresh.lifecycle !== "UPLOADING" && fresh.lifecycle !== "READY")) {
        throw new ArtifactError("artifact state conflict", "STATE_CONFLICT");
      }
      meta = fresh;
    } else {
      meta = transitioned;
    }
    const uploadUrl = await this.objects.createUploadUrl({
      key: meta.objectKey,
      contentType: input.contentType,
      expiresInSec: this.cfg.presignExpirySec,
    });
    return { meta, uploadUrl };
  }

  /**
   * Phase 16/19 — confirm upload.
   *   HEAD object (verify exists + size) → SHA-256 (optional) →
   *   transition UPLOADING→READY with byteSize + sha256.
   * Idempotent: confirming an already-READY artifact returns it unchanged.
   */
  async confirmUpload(
    tenantId: string,
    runId: string,
    artifactId: string,
    opts: { sha256?: string } = {},
  ): Promise<ConfirmArtifactResult> {
    assertTenantScoped(tenantId, runId, artifactId);
    const meta = await this.metadata.get(tenantId, runId, artifactId);
    if (!meta) throw new ArtifactError("artifact not found", "NOT_FOUND");
    if (meta.lifecycle === "READY") return { meta };
    if (meta.lifecycle !== "UPLOADING") {
      throw new ArtifactError(
        `cannot confirm artifact in state ${meta.lifecycle}`,
        "BAD_STATE",
      );
    }
    const head = await this.objects.head(meta.objectKey);
    if (!head) {
      // Object missing → mark FAILED, do NOT create dangling READY.
      await this.metadata.transition({
        tenantId,
        runId,
        artifactId,
        expected: "UPLOADING",
        to: "FAILED",
      });
      throw new ArtifactError("object missing in storage", "OBJECT_MISSING");
    }
    const confirmed = await this.metadata.transition({
      tenantId,
      runId,
      artifactId,
      expected: "UPLOADING",
      to: "READY",
      byteSize: head.byteSize,
      sha256: opts.sha256 ?? meta.sha256,
    });
    if (!confirmed) {
      const fresh = await this.metadata.get(tenantId, runId, artifactId);
      if (fresh?.lifecycle === "READY") return { meta: fresh };
      throw new ArtifactError("artifact state conflict on confirm", "STATE_CONFLICT");
    }
    return { meta: confirmed };
  }

  /**
   * Phase 17 — download flow.
   *   authorize (tenant/run) → load → require READY (not deleted/wrong tenant)
   *   → presigned GET.
   */
  async beginDownload(
    tenantId: string,
    runId: string,
    artifactId: string,
  ): Promise<DownloadArtifactResult> {
    assertTenantScoped(tenantId, runId, artifactId);
    const meta = await this.metadata.get(tenantId, runId, artifactId);
    if (!meta) throw new ArtifactError("artifact not found", "NOT_FOUND");
    if (meta.lifecycle !== "READY") {
      throw new ArtifactError(
        `artifact not downloadable (${meta.lifecycle})`,
        "NOT_READY",
      );
    }
    const downloadUrl = await this.objects.createDownloadUrl({
      key: meta.objectKey,
      expiresInSec: this.cfg.presignExpirySec,
    });
    return { meta, downloadUrl };
  }

  /**
   * Phase 20 — delete flow (safe, idempotent).
   *   READY/UPLOADING/FAILED → DELETING → delete object → purge metadata.
   * If object delete fails, remains DELETING; reconciliation retries.
   */
  async deleteArtifact(
    tenantId: string,
    runId: string,
    artifactId: string,
  ): Promise<ArtifactMeta> {
    assertTenantScoped(tenantId, runId, artifactId);
    const meta = await this.metadata.get(tenantId, runId, artifactId);
    // Idempotent delete (§20): an already-absent row is treated as deleted.
    if (!meta) {
      return {
        artifactId,
        tenantId,
        runId,
        objectKey: this.computeKey(tenantId, runId, artifactId),
        lifecycle: "DELETED",
        contentType: "",
        byteSize: null,
        sha256: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        uploadedAt: null,
        deletedAt: nowIso(),
      };
    }
    if (meta.lifecycle === "DELETED") return meta;
    const marked = await this.metadata.transition({
      tenantId,
      runId,
      artifactId,
      expected: meta.lifecycle,
      to: "DELETING",
    });
    const target = marked ?? meta;
    // Best-effort object delete; idempotent (R2 DELETE on missing = success).
    await this.objects.delete(target.objectKey);
    await this.metadata.purge(tenantId, runId, artifactId);
    return { ...target, lifecycle: "DELETED", deletedAt: nowIso() };
  }

  private computeKey(tenantId: string, runId: string, artifactId: string): string {
    return artifactObjectKey({ tenantId, runId, artifactId });
  }

  /**
   * Phase 21 — reconciliation. Repairs safe divergence between metadata and
   * object store. Never deletes unknown objects blindly; only objects whose
   * key matches a tenant-scoped artifact prefix and a known artifact row are
   * considered for deletion.
   *
   * Classes handled:
   *   A. READY but object missing  → FAILED (object lost; metadata not READY)
   *   B. object exists but meta missing → reported as orphan (not deleted)
   *   C. DELETING but object exists → retry object delete + purge
   *   D. UPLOADING past grace → FAILED (stalled upload)
   *   E. orphaned objects (key matches pattern, no meta) → reported
   *   F. stale upload reservations handled by D
   */
  async reconcile(
    tenantId: string,
    opts: { now?: number; objectKeys?: string[] } = {},
  ): Promise<ReconcileReport> {
    const now = opts.now ?? Date.now();
    const report: ReconcileReport = {
      scanned: 0,
      repaired: 0,
      orphanObjects: [],
      details: [],
    };
    const rows = await this.metadata.listByTenant(tenantId);
    const knownKeys = new Set(rows.map((r) => r.objectKey));
    for (const row of rows) {
      report.scanned++;
      if (row.lifecycle === "READY") {
        const present = await this.objects.exists(row.objectKey);
        if (!present) {
          await this.metadata.transition({
            tenantId,
            runId: row.runId,
            artifactId: row.artifactId,
            expected: "READY",
            to: "FAILED",
          });
          report.repaired++;
          report.details.push(`A: READY→FAILED (object missing) ${row.objectKey}`);
        }
      } else if (row.lifecycle === "DELETING") {
        await this.objects.delete(row.objectKey);
        await this.metadata.purge(tenantId, row.runId, row.artifactId);
        report.repaired++;
        report.details.push(`C: DELETING→DELETED (object purged) ${row.objectKey}`);
      } else if (row.lifecycle === "UPLOADING") {
        const ts = row.uploadedAt ? Date.parse(row.uploadedAt) : Date.parse(row.updatedAt);
        if (now - ts > this.cfg.uploadingGraceMs) {
          await this.metadata.transition({
            tenantId,
            runId: row.runId,
            artifactId: row.artifactId,
            expected: "UPLOADING",
            to: "FAILED",
          });
          report.repaired++;
          report.details.push(`D: UPLOADING→FAILED (stalled) ${row.objectKey}`);
        }
      }
    }
    // Class B/E: objects whose key matches our tenant prefix but no metadata.
    if (opts.objectKeys) {
      const prefix = `tenants/${tenantId}/runs/`;
      for (const key of opts.objectKeys) {
        if (key.startsWith(prefix) && !knownKeys.has(key)) {
          report.orphanObjects.push(key);
          report.details.push(`B/E: orphan object (no metadata) ${key}`);
        }
      }
    }
    return report;
  }
}

export class ArtifactError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_FOUND"
      | "NOT_READY"
      | "BAD_STATE"
      | "STATE_CONFLICT"
      | "OBJECT_MISSING"
      | "ARTIFACT_DELETED"
      | "ARTIFACT_FAILED"
      | "FORBIDDEN",
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

/**
 * In-memory ArtifactMetadataStore. TEST/LOCAL only. Mirrors the Postgres
 * adapter's fencing semantics: transition returns null on expected-state
 * mismatch (so the service can re-read authoritative state).
 */
export class InMemoryArtifactMetadataStore implements ArtifactMetadataStore {
  private readonly rows = new Map<string, ArtifactMeta>();

  private pk(tenantId: string, runId: string, artifactId: string): string {
    return `${tenantId}/${runId}/${artifactId}`;
  }

  async reserve(input: ReserveInput): Promise<ArtifactMeta> {
    const key = this.pk(input.tenantId, input.runId, input.artifactId);
    const existing = this.rows.get(key);
    if (existing) return existing;
    const ts = nowIso();
    const meta: ArtifactMeta = {
      artifactId: input.artifactId,
      tenantId: input.tenantId,
      runId: input.runId,
      objectKey: artifactObjectKey({
        tenantId: input.tenantId,
        runId: input.runId,
        artifactId: input.artifactId,
      }),
      lifecycle: "RESERVED",
      contentType: input.contentType,
      byteSize: null,
      sha256: null,
      createdAt: ts,
      updatedAt: ts,
      uploadedAt: null,
      deletedAt: null,
    };
    this.rows.set(key, meta);
    return meta;
  }

  async get(
    tenantId: string,
    runId: string,
    artifactId: string,
  ): Promise<ArtifactMeta | null> {
    return this.rows.get(this.pk(tenantId, runId, artifactId)) ?? null;
  }

  async transition(input: TransitionInput): Promise<ArtifactMeta | null> {
    const key = this.pk(input.tenantId, input.runId, input.artifactId);
    const cur = this.rows.get(key);
    if (!cur || cur.lifecycle !== input.expected) return null;
    const ts = nowIso();
    const next: ArtifactMeta = {
      ...cur,
      lifecycle: input.to,
      byteSize: input.byteSize !== undefined ? input.byteSize : cur.byteSize,
      sha256: input.sha256 !== undefined ? input.sha256 : cur.sha256,
      objectKey: input.objectKey ?? cur.objectKey,
      updatedAt: ts,
      uploadedAt:
        input.to === "UPLOADING" ? ts : cur.uploadedAt,
      deletedAt: input.to === "DELETED" ? ts : cur.deletedAt,
    };
    this.rows.set(key, next);
    return next;
  }

  async listByRun(tenantId: string, runId: string): Promise<ArtifactMeta[]> {
    return [...this.rows.values()].filter(
      (r) => r.tenantId === tenantId && r.runId === runId,
    );
  }

  async listByTenant(tenantId: string): Promise<ArtifactMeta[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId);
  }

  async purge(tenantId: string, runId: string, artifactId: string): Promise<void> {
    this.rows.delete(this.pk(tenantId, runId, artifactId));
  }
}
