/**
 * Phase 5 — server-side wiring of the artifact service.
 *
 * ADAPTER BOUNDARY (apps/web). This is the ONLY place the app constructs the
 * real R2 object store and the Postgres metadata store together. Provider SDK
 * imports (@aws-sdk, drizzle/neon) stay confined to their respective adapter
 * packages; this module only composes them.
 *
 * If R2 credentials are absent the function throws — callers must handle the
 * missing-infrastructure case (routes return 503, never a fake success).
 */

import {
  ArtifactService,
  type ArtifactServiceConfig,
  type ObjectStore,
} from "@vaulltcore/storage";
import { hasR2Config, R2ObjectStore } from "@vaulltcore/storage/r2";
import { PostgresArtifactMetadataStore } from "@/lib/db/artifacts";

let cached: ArtifactService | null = null;

export function getArtifactService(config?: Partial<ArtifactServiceConfig>): ArtifactService {
  if (cached) return cached;
  if (!hasR2Config()) {
    throw new Error("R2 not configured (missing R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET)");
  }
  const objects: ObjectStore = R2ObjectStore.fromEnv();
  const metadata = new PostgresArtifactMetadataStore();
  cached = new ArtifactService(metadata, objects, config);
  return cached;
}

export { hasR2Config };
