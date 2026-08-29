/**
 * Phase 5 — REAL Cloudflare R2 infrastructure gate.
 *
 * Runs the full artifact lifecycle against an ACTUAL R2 bucket via the
 * S3-compatible API. No mocks, no memory store.
 *
 * Activation env keys (never committed):
 *   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
 *
 * Without them every test reports SKIPPED — missing infrastructure (§42).
 * With them the gate proves: put/head/get/delete/exists, presigned PUT+GET,
 * sha-256 attribution, idempotent delete, presign clamping, and records raw
 * latency samples per operation (§32 — network latency labeled separately).
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import {
  MAX_PRESIGN_EXPIRY_SEC,
  MIN_PRESIGN_EXPIRY_SEC,
  artifactObjectKey,
} from "./object-store";
import { hasR2Config, R2ObjectStore, R2_ENV_KEYS } from "./r2/index";

const HAS_R2 = hasR2Config();
// Resolve relative to THIS file so evidence lands in repo docs regardless of CWD.
const EVIDENCE_DIR = `${import.meta.dir}/../../docs/vaulltcore/phase5/raw-results`;
const RUN = `r2gate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TENANT_A = `${RUN}-tenant-a`;
const TENANT_B = `${RUN}-tenant-b`;
const KEY_A = artifactObjectKey({
  tenantId: TENANT_A,
  runId: "run-1",
  artifactId: "artifact-1",
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface OpSample {
  op: string;
  ms: number;
}

describe("Phase 5 — real Cloudflare R2 gate", () => {
  it("gate status records activation state", () => {
    writeEvidenceFile("r2-gate-status.json", {
      activated: HAS_R2,
      requiredEnvKeys: R2_ENV_KEYS,
      verdict: HAS_R2 ? "ACTIVATED" : "SKIPPED — missing infrastructure",
    });
    if (!HAS_R2) {
      console.log(
        `[r2-real-gate] SKIPPED — missing infrastructure: set ${R2_ENV_KEYS.join(", ")}`,
      );
    }
    expect(true).toBe(true);
  });

  it
    .skipIf(!HAS_R2)("put → head → get round-trip with sha-256 attribution", async () => {
      const store = R2ObjectStore.fromEnv();
      const samples: OpSample[] = [];
      const body = new TextEncoder().encode(`vaulltcore-r2-gate:${RUN}`);
      const digest = sha256(body);

      let t = performance.now();
      const putHead = await store.put({
        key: KEY_A,
        body,
        contentType: "text/plain",
        metadata: { sha256: digest, tenant: TENANT_A },
      });
      samples.push({ op: "PUT", ms: Math.round(performance.now() - t) });

      expect(putHead.byteSize).toBe(body.byteLength);

      t = performance.now();
      const head = await store.head(KEY_A);
      samples.push({ op: "HEAD", ms: Math.round(performance.now() - t) });

      expect(head).not.toBeNull();
      expect(head!.byteSize).toBe(body.byteLength);
      expect(head!.contentType).toBe("text/plain");
      expect(head!.metadata?.sha256).toBe(digest);

      t = performance.now();
      const got = await store.get(KEY_A);
      samples.push({ op: "GET", ms: Math.round(performance.now() - t) });

      expect(got).not.toBeNull();
      expect(sha256(got!.body)).toBe(digest); // cryptographic attribution (§19)

      writeEvidenceFile("r2-upload-download.json", {
        scenario: "real R2 put/head/get round-trip",
        keyPattern: "tenants/{tenantId}/runs/{runId}/artifacts/{artifactId}",
        sha256Verified: true,
        latencySamplesMs: samples,
        verdict: "PASS",
      });
    });

  it
    .skipIf(!HAS_R2)("delete is idempotent; deleted key reads as absent", async () => {
      const store = R2ObjectStore.fromEnv();
      await store.put({ key: KEY_A, body: "to-delete", contentType: "text/plain" });
      expect(await store.exists(KEY_A)).toBe(true);

      let t = performance.now();
      await store.delete(KEY_A);
      const firstDeleteMs = Math.round(performance.now() - t);

      t = performance.now();
      await store.delete(KEY_A); // second delete must succeed (idempotent)
      const secondDeleteMs = Math.round(performance.now() - t);

      expect(await store.exists(KEY_A)).toBe(false);
      expect(await store.get(KEY_A)).toBeNull();

      writeEvidenceFile("r2-delete.json", {
        scenario: "real R2 idempotent delete",
        firstDeleteMs,
        secondDeleteMs,
        absentAfterDelete: true,
        verdict: "PASS",
      });
    });

  it
    .skipIf(!HAS_R2)("presigned URLs are operation-specific, clamped, content-type bound", async () => {
      const store = R2ObjectStore.fromEnv();
      await store.put({ key: KEY_A, body: "payload", contentType: "text/plain" });

      const up = await store.createUploadUrl({
        key: KEY_A,
        contentType: "application/pdf",
        expiresInSec: 999_999,
      });
      const down = await store.createDownloadUrl({
        key: KEY_A,
        expiresInSec: 1,
      });

      expect(up.method).toBe("PUT");
      expect(down.method).toBe("GET");
      expect(up.expiresInSec).toBe(MAX_PRESIGN_EXPIRY_SEC); // clamped ≤900s (§37)
      expect(down.expiresInSec).toBe(MIN_PRESIGN_EXPIRY_SEC);
      expect(up.requiredHeaders["Content-Type"]).toBe("application/pdf");
      expect(up.url).toContain("X-Amz-Signature");
      expect(up.url).toContain(KEY_A.split("/").pop()!);

      // Never log the full signed URL (§37/§44) — record shape only.
      writeEvidenceFile("r2-presign-security.json", {
        scenario: "presign clamping and binding",
        uploadExpiryClampedTo: up.expiresInSec,
        downloadExpiryClampedTo: down.expiresInSec,
        contentTypeBound: Boolean(up.requiredHeaders["Content-Type"]),
        urlShape: up.url.replace(/([?&])(X-Amz-(Signature|Date|Credential))=[^&]*/g, "$1$2=REDACTED"),
        verdict: "PASS",
      });

      await store.delete(KEY_A);
    });

  it
    .skipIf(!HAS_R2)("cross-tenant keys are structurally isolated namespaces", async () => {
      const store = R2ObjectStore.fromEnv();
      const keyB = artifactObjectKey({
        tenantId: TENANT_B,
        runId: "run-1",
        artifactId: "artifact-1",
      });

      await store.put({ key: KEY_A, body: "a-data", contentType: "text/plain" });
      await store.put({ key: keyB, body: "b-data", contentType: "text/plain" });

      // Distinct tenants produce distinct keys for identical run/artifact ids.
      expect(KEY_A !== keyB).toBe(true);
      expect(keyB.startsWith(`tenants/${TENANT_B}/`)).toBe(true);

      // NOTE (§23): structural isolation is necessary but NOT sufficient.
      // Authorization comes from PostgreSQL artifact metadata — proven by the
      // artifact-service adversarial suite (apps/web/lib/artifacts).
      writeEvidenceFile("r2-key-isolation.json", {
        scenario: "tenant-scoped key construction on real bucket",
        distinctKeysForSameArtifactIds: true,
        authorizationLayer: "postgresql-artifact-metadata",
        verdict: "PASS",
      });

      await store.delete(KEY_A);
      await store.delete(keyB);
    });
});

function writeEvidenceFile(fileName: string, data: Record<string, unknown>): void {
  // Evidence retention must never break the gate itself.
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(
      `${EVIDENCE_DIR}/${fileName}`,
      JSON.stringify({ collectedAt: new Date().toISOString(), ...data }, null, 2),
    );
  } catch {
    // best-effort
  }
}
