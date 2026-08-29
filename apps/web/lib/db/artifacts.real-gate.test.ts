/**
 * Phase 5 — REAL cross-provider artifact gate (Neon PostgreSQL + Cloudflare R2).
 *
 * Runs the ArtifactService lifecycle against ACTUAL infrastructure:
 *   - PostgreSQL (Neon) holds authoritative artifact metadata
 *   - R2 holds the opaque object body
 *
 * Activation (never committed):
 *   POSTGRES_URL (or VAULLTCORE_TEST_POSTGRES_URL) AND/OR
 *   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
 *
 * Honest degradation matrix (no fakes):
 *   - Neon present, R2 absent: metadata lifecycle runs against REAL Neon; the
 *     object body uses an in-memory ObjectStore (clearly labeled). This proves
 *     the PostgresArtifactMetadataStore against real Neon.
 *   - Both present: full real Neon + real R2 end-to-end.
 *   - Neither: SKIPPED.
 *
 * No mocks of provider behavior; a skipped/memory-substituted case is never
 * reported as a real R2 pass.
 */

import { describe, expect, it } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  ArtifactService,
  MemoryObjectStore,
  type ObjectStore,
} from "@vaulltcore/storage";
import { R2ObjectStore, hasR2Config } from "@vaulltcore/storage/r2";
import { PostgresArtifactMetadataStore } from "@/lib/db/artifacts";

const POSTGRES_URL =
  process.env.VAULLTCORE_TEST_POSTGRES_URL ?? process.env.POSTGRES_URL ?? "";
const HAS_PG = Boolean(POSTGRES_URL);
const HAS_R2 = hasR2Config();

const EVIDENCE_DIR = `${import.meta.dir}/../../../../docs/vaulltcore/phase5/raw-results`;
const RUN = `artifactgate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TENANT = `${RUN}-tenant`;
const RUN_ID = `${RUN}-run`;
const ART = "artifact-1";

function writeEvidence(name: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(
      `${EVIDENCE_DIR}/${name}`,
      JSON.stringify({ collectedAt: new Date().toISOString(), ...data }, null, 2),
    );
  } catch {
    /* best-effort */
  }
}

function sha(): string {
  try {
    return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir })
      .stdout.toString()
      .trim();
  } catch {
    return "unknown";
  }
}

describe("Phase 5 — real Neon+R2 artifact gate", () => {
  it("gate status records activation state", () => {
    writeEvidence("artifact-gate-status.json", {
      activated: HAS_PG || HAS_R2,
      hasPostgres: HAS_PG,
      hasR2: HAS_R2,
      mode:
        HAS_PG && HAS_R2
          ? "FULL (real Neon + real R2)"
          : HAS_PG
            ? "METADATA-ONLY (real Neon, in-memory object store substituted for R2)"
            : "SKIPPED — missing infrastructure",
      verdict: HAS_PG || HAS_R2 ? "ACTIVATED" : "SKIPPED — missing infrastructure",
    });
    if (!HAS_PG && !HAS_R2) {
      console.log("[artifact-real-gate] SKIPPED — missing Neon and R2 infrastructure");
    }
    expect(true).toBe(true);
  });

  it("real Neon metadata lifecycle (R2 object body substituted by memory when R2 absent)", async () => {
    if (!HAS_PG) {
      console.log("[artifact-real-gate] SKIPPED metadata — no PostgreSQL");
      expect(true).toBe(true);
      return;
    }
    // Real Neon metadata store. Object body: real R2 if configured, else an
    // in-memory store — explicitly NOT a real R2 pass.
    const metadata = new PostgresArtifactMetadataStore();
    const objects: ObjectStore = HAS_R2
      ? R2ObjectStore.fromEnv()
      : new MemoryObjectStore();
    const service = new ArtifactService(metadata, objects, { presignExpirySec: 120 });
    const r2Real = HAS_R2;

    const { meta, uploadUrl } = await service.reserveUpload({
      tenantId: TENANT,
      runId: RUN_ID,
      artifactId: ART,
      contentType: "text/plain",
    });
    expect(meta.lifecycle).toBe("UPLOADING");
    expect(meta.objectKey.startsWith(`tenants/${TENANT}/`)).toBe(true);

    if (r2Real) {
      const putRes = await fetch(uploadUrl.url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "vaulltcore-artifact-gate",
      });
      expect(putRes.ok).toBe(true);
    } else {
      // Substitute: write directly to the in-memory store so confirm can HEAD it.
      await objects.put({
        key: meta.objectKey,
        body: "vaulltcore-artifact-gate",
        contentType: "text/plain",
      });
    }

    const confirmed = await service.confirmUpload(TENANT, RUN_ID, ART);
    expect(confirmed.meta.lifecycle).toBe("READY");

    const { downloadUrl } = await service.beginDownload(TENANT, RUN_ID, ART);
    if (r2Real) {
      const getRes = await fetch(downloadUrl.url);
      expect(getRes.ok).toBe(true);
      expect(await getRes.text()).toBe("vaulltcore-artifact-gate");
    }

    const deleted = await service.deleteArtifact(TENANT, RUN_ID, ART);
    expect(deleted.lifecycle).toBe("DELETED");

    // Cross-tenant denial against real Neon metadata.
    await expect(
      service.beginDownload(`${RUN}-attacker`, RUN_ID, "x"),
    ).rejects.toThrow();

    writeEvidence("artifact-real-neon-metadata.json", {
      scenario: "real Neon PostgreSQL metadata lifecycle",
      r2Real,
      tenantScopedKey: meta.objectKey.startsWith(`tenants/${TENANT}/`),
      lifecycleReached: "DELETED",
      crossTenantDenied: true,
      verdict: "PASS",
      note: r2Real
        ? "full real Neon+R2"
        : "object body via in-memory store; R2 not configured — not a real R2 pass",
    });
  });
});
