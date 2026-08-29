/**
 * Phase 5 — artifact download (presigned GET) endpoint.
 *
 * GET /api/artifacts/download/[artifactId]?runId=...
 * -> 200 { artifactId, lifecycle, downloadUrl }
 *
 * Authorization: authenticated + run ownership + artifact must be READY. No
 * download URL is issued for unknown/deleted/wrong-tenant artifacts.
 */

import {
  requireAuthenticatedUser,
} from "@/app/api/sessions/_lib/session-context";
import { getSessionById } from "@/lib/db/sessions";
import { getArtifactService, hasR2Config } from "@/lib/storage/server";
import { ArtifactError } from "@vaulltcore/storage";

export async function GET(
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
    const { meta, downloadUrl } = await service.beginDownload(
      auth.userId,
      runId,
      artifactId,
    );
    return Response.json({
      artifactId: meta.artifactId,
      lifecycle: meta.lifecycle,
      downloadUrl,
    });
  } catch (err) {
    if (err instanceof ArtifactError && err.code === "NOT_FOUND") {
      return Response.json({ error: "artifact not found" }, { status: 404 });
    }
    if (err instanceof ArtifactError && err.code === "NOT_READY") {
      return Response.json({ error: "artifact not ready" }, { status: 409 });
    }
    return Response.json({ error: "download failed" }, { status: 500 });
  }
}
