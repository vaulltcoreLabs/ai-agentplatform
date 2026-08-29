/**
 * Phase 5 — artifact upload reservation endpoint.
 *
 * POST /api/artifacts/reserve
 * body: { runId, artifactId, contentType }
 * -> 200 { artifactId, objectKey, lifecycle, uploadUrl }
 *
 * Authorization: caller must be authenticated; `runId` must be a session they
 * own (enforced via getSessionById). The presigned PUT is tenant-scoped and
 * Content-Type-bound. No R2 credentials leave the server.
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

  if (!hasR2Config()) {
    return Response.json({ error: "object storage not configured" }, { status: 503 });
  }

  let body: { runId?: string; artifactId?: string; contentType?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const { runId, artifactId, contentType } = body;
  if (!runId || !artifactId || !contentType) {
    return Response.json(
      { error: "runId, artifactId, contentType required" },
      { status: 400 },
    );
  }

  // Run ownership: runId is the session id; the caller must own it.
  const session = await getSessionById(runId);
  if (!session || session.userId !== auth.userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const service = getArtifactService();
    const { meta, uploadUrl } = await service.reserveUpload({
      tenantId: auth.userId,
      runId,
      artifactId,
      contentType,
    });
    return Response.json({
      artifactId: meta.artifactId,
      objectKey: meta.objectKey,
      lifecycle: meta.lifecycle,
      uploadUrl,
    });
  } catch (err) {
    if (err instanceof ArtifactError && err.code === "ARTIFACT_FAILED") {
      return Response.json({ error: "artifact failed; use a new artifactId" }, { status: 409 });
    }
    return Response.json({ error: "reservation failed" }, { status: 500 });
  }
}
