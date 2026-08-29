/**
 * Phase 5 — artifact upload confirmation endpoint.
 *
 * POST /api/artifacts/confirm
 * body: { runId, artifactId, sha256? }
 * -> 200 { artifactId, lifecycle, byteSize, sha256 }
 *
 * Authorization: authenticated + run ownership. The service HEADS the object in
 * R2 (verify presence + size), marks READY, and records sha256 in Postgres.
 * A missing object is marked FAILED — never a dangling READY.
 */

import {
  requireAuthenticatedUser,
} from "@/app/api/sessions/_lib/session-context";
import { getSessionById } from "@/lib/db/sessions";
import { getArtifactService, hasR2Config } from "@/lib/storage/server";
import { ArtifactError } from "@vaulltcore/storage";

export async function POST(req: Request) {
  const auth = await requireAuthenticatedUser(req.headers);
  if (!auth.ok) return auth.response;

  let body: { runId?: string; artifactId?: string; sha256?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const { runId, artifactId, sha256 } = body;
  if (!runId || !artifactId) {
    return Response.json({ error: "runId, artifactId required" }, { status: 400 });
  }

  const session = await getSessionById(runId);
  if (!session || session.userId !== auth.userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const service = getArtifactService();
    const { meta } = await service.confirmUpload(auth.userId, runId, artifactId, {
      sha256,
    });
    return Response.json({
      artifactId: meta.artifactId,
      lifecycle: meta.lifecycle,
      byteSize: meta.byteSize,
      sha256: meta.sha256,
    });
  } catch (err) {
    if (err instanceof ArtifactError && err.code === "OBJECT_MISSING") {
      return Response.json({ error: "object missing in storage" }, { status: 409 });
    }
    if (err instanceof ArtifactError && err.code === "NOT_FOUND") {
      return Response.json({ error: "artifact not found" }, { status: 404 });
    }
    return Response.json({ error: "confirm failed" }, { status: 500 });
  }
}
