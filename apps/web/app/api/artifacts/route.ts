/**
 * Artifact listing endpoint.
 *
 * GET /api/artifacts?runId=...
 * -> 200 { artifacts: ArtifactMeta[] }
 *
 * Authorization: caller must be authenticated; runId must be a session they
 * own (enforced via getSessionById). No artifact data leaves the server
 * without tenant-scoping.
 */

import { requireAuthenticatedUser } from "@/app/api/sessions/_lib/session-context";
import { getSessionById } from "@/lib/db/sessions";
import { PostgresArtifactMetadataStore } from "@/lib/db/artifacts";
import { hasR2Config } from "@/lib/storage/server";

export async function GET(req: Request) {
  const auth = await requireAuthenticatedUser(req.headers);
  if (!auth.ok) return auth.response;

  const runId = new URL(req.url).searchParams.get("runId");
  if (!runId) {
    return Response.json({ error: "runId required" }, { status: 400 });
  }

  const session = await getSessionById(runId);
  if (!session || session.userId !== auth.userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  if (!hasR2Config()) {
    return Response.json({ artifacts: [] });
  }

  try {
    const store = new PostgresArtifactMetadataStore();
    const artifacts = await store.listByRun(auth.userId, runId);
    return Response.json({ artifacts });
  } catch {
    return Response.json({ error: "list failed" }, { status: 500 });
  }
}
