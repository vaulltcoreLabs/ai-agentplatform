-- Phase 5 — artifact metadata table. PostgreSQL is the authoritative store for
-- artifact ownership, authorization, and lifecycle; R2 holds only the body.
CREATE TABLE IF NOT EXISTS "artifacts" (
  "artifact_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "run_id" text NOT NULL,
  "object_key" text NOT NULL,
  "lifecycle" text NOT NULL DEFAULT 'RESERVED'
    CHECK ("lifecycle" IN ('RESERVED','UPLOADING','READY','FAILED','DELETING','DELETED')),
  "content_type" text NOT NULL,
  "byte_size" integer,
  "sha256" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "uploaded_at" timestamp,
  "deleted_at" timestamp,
  PRIMARY KEY ("tenant_id", "run_id", "artifact_id")
);

CREATE INDEX IF NOT EXISTS "artifacts_tenant_run_idx"
  ON "artifacts" ("tenant_id", "run_id");
CREATE INDEX IF NOT EXISTS "artifacts_tenant_idx"
  ON "artifacts" ("tenant_id");
