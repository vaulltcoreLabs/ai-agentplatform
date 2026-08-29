import { getInstallationByUserAndId } from "@/lib/db/installations";
import { listUserInstallationRepositories } from "@/lib/github/repos";
import { getUserGitHubToken } from "@/lib/github/token";
import { getServerSession } from "@/lib/session/get-server-session";

function parseInstallationId(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

export async function GET(req: Request) {
  const session = await getServerSession(req.headers);

  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const installationId = parseInstallationId(
    searchParams.get("installation_id"),
  );
  const query = searchParams.get("query")?.trim() || undefined;
  const limitParam = searchParams.get("limit");
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  const limit =
    typeof parsedLimit === "number" && Number.isFinite(parsedLimit)
      ? parsedLimit
      : undefined;

  if (!installationId) {
    return Response.json(
      { error: "installation_id is required" },
      { status: 400 },
    );
  }

  const installation = await getInstallationByUserAndId(
    session.user.id,
    installationId,
  );
  if (!installation) {
    return Response.json({ error: "Installation not found" }, { status: 403 });
  }

  const userToken = await getUserGitHubToken(session.user.id);
  if (!userToken) {
    return Response.json({ error: "GitHub not connected" }, { status: 401 });
  }

  try {
    const repos = await listUserInstallationRepositories({
      installationId,
      userToken,
      owner: installation.accountLogin,
      query,
      limit,
    });

    return Response.json(repos);
  } catch (error) {
    console.error("Failed to fetch installation repositories:", error);
    return Response.json(
      { error: "Failed to fetch repositories" },
      { status: 500 },
    );
  }
}
