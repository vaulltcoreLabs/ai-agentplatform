/**
 * Phase 5 — PostgreSQL (Neon) implementation of ArtifactMetadataStore.
 *
 * ADAPTER BOUNDARY (apps/web/lib/db). This is the ONLY place artifact metadata
 * touches Postgres. It imports drizzle/neon (runtime DB client) — allowed here,
 * never in provider-neutral packages.
 *
 * Authorization: every query is scoped by tenant_id. A caller with the wrong
 * tenant_id simply gets no rows — there is no path that reads another tenant's
 * artifact metadata. R2 object keys are tenant-scoped by construction
 * (packages/storage/object-store.ts), so even with the key a tenant cannot
 * address another tenant's namespace.
 *
 * Fencing: `transition` performs a single UPDATE ... WHERE lifecycle = $expected
 * AND tenant/run/id match. If the row's current lifecycle differs, zero rows
 * are affected and we return null (lost race / stale worker), exactly mirroring
 * the in-memory store's semantics used by the test suite.
 */

import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { artifacts, type ArtifactRow } from "./schema";
import type {
  ArtifactLifecycle,
  ArtifactMeta,
  ArtifactMetadataStore,
  ReserveInput,
  TransitionInput,
} from "@vaulltcore/storage";

function rowToMeta(r: ArtifactRow): ArtifactMeta {
  return {
    artifactId: r.artifactId,
    tenantId: r.tenantId,
    runId: r.runId,
    objectKey: r.objectKey,
    lifecycle: r.lifecycle as ArtifactLifecycle,
    contentType: r.contentType,
    byteSize: r.byteSize,
    sha256: r.sha256,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    uploadedAt: r.uploadedAt?.toISOString() ?? null,
    deletedAt: r.deletedAt?.toISOString() ?? null,
  };
}

export class PostgresArtifactMetadataStore implements ArtifactMetadataStore {
  async reserve(input: ReserveInput): Promise<ArtifactMeta> {
    const existing = await this.get(input.tenantId, input.runId, input.artifactId);
    if (existing) return existing;
    const objectKey = `tenants/${input.tenantId}/runs/${input.runId}/artifacts/${input.artifactId}`;
    const [row] = await db
      .insert(artifacts)
      .values({
        artifactId: input.artifactId,
        tenantId: input.tenantId,
        runId: input.runId,
        objectKey,
        lifecycle: "RESERVED",
        contentType: input.contentType,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return rowToMeta(row);
    const reread = await this.get(input.tenantId, input.runId, input.artifactId);
    if (!reread) throw new Error("artifact reserve failed");
    return reread;
  }

  async get(
    tenantId: string,
    runId: string,
    artifactId: string,
  ): Promise<ArtifactMeta | null> {
    const [row] = await db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.tenantId, tenantId),
          eq(artifacts.runId, runId),
          eq(artifacts.artifactId, artifactId),
        ),
      )
      .limit(1);
    return row ? rowToMeta(row) : null;
  }

  async transition(input: TransitionInput): Promise<ArtifactMeta | null> {
    const now = new Date();
    const [row] = await db
      .update(artifacts)
      .set({
        lifecycle: input.to,
        byteSize: input.byteSize !== undefined ? input.byteSize : undefined,
        sha256: input.sha256 !== undefined ? input.sha256 : undefined,
        objectKey: input.objectKey,
        uploadedAt: input.to === "UPLOADING" ? now : undefined,
        deletedAt: input.to === "DELETED" ? now : undefined,
        updatedAt: now,
      })
      .where(
        and(
          eq(artifacts.tenantId, input.tenantId),
          eq(artifacts.runId, input.runId),
          eq(artifacts.artifactId, input.artifactId),
          eq(artifacts.lifecycle, input.expected),
        ),
      )
      .returning();
    return row ? rowToMeta(row) : null;
  }

  async listByRun(tenantId: string, runId: string): Promise<ArtifactMeta[]> {
    const rows = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.tenantId, tenantId), eq(artifacts.runId, runId)));
    return rows.map(rowToMeta);
  }

  async listByTenant(tenantId: string): Promise<ArtifactMeta[]> {
    const rows = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.tenantId, tenantId));
    return rows.map(rowToMeta);
  }

  async purge(tenantId: string, runId: string, artifactId: string): Promise<void> {
    await db
      .delete(artifacts)
      .where(
        and(
          eq(artifacts.tenantId, tenantId),
          eq(artifacts.runId, runId),
          eq(artifacts.artifactId, artifactId),
        ),
      );
  }
}
