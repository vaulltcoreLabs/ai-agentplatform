/**
 * Phase 5 — artifact delete endpoint.
 *
 * DELETE /api/artifacts/[artifactId]?runId=...
 * -> 200 { artifactId, lifecycle }
 *
 * Authorization: authenticated + run ownership. Safe, idempotent: transitions
 * READY/UPLOADING/FAILED -> DELETING -> delete object -> purge metadata. A
 * missing row is an idempotent no-op (returns DELETED). Never deletes another
 * tenant's artifact because the metadata query is tenant-scoped.
 */

import {
  requireAuthenticatedUser,
} from "@/app/api/sessions/_lib/session-context";
import { getSessionById } from "@/lib/db/sessions";
import { getArtifactService } from "@/lib/storage/server";
import { ArtifactError } from "@vaulltcore/storage";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  const auth = await requireAuthenticatedUser(req.headers);
  if (!auth.ok) return auth.response;

  const { artifactId } = await params;
  const runId = new URL(req.url).searchParams.get("runId");
  if (!runId) {
    return Response.json({ error: "runId required" }, { status: 400 });
  }

  const session = await getSessionById(runId);
  if (!session || session.userId !== auth.userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const service = getArtifactService();
    const meta = await service.deleteArtifact(auth.userId, runId, artifactId);
    return Response.json({ artifactId: meta.artifactId, lifecycle: meta.lifecycle });
  } catch (err) {
    if (err instanceof ArtifactError && err.code === "NOT_FOUND") {
      return Response.json({ error: "artifact not found" }, { status: 404 });
    }
    return Response.json({ error: "delete failed" }, { status: 500 });
  }
}
