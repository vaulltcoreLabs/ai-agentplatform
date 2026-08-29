import { getServerSession } from "@/lib/session/get-server-session";
import { getUserGitHubToken } from "@/lib/github/token";
import { fetchGitHubOrgs } from "@/lib/github/users";

export async function GET(req: Request) {
  const session = await getServerSession(req.headers);

  if (!session?.user?.id) {
    return Response.json({ error: "GitHub not connected" }, { status: 401 });
  }

  const token = await getUserGitHubToken(session.user.id);

  if (!token) {
    return Response.json({ error: "GitHub not connected" }, { status: 401 });
  }

  try {
    const orgs = await fetchGitHubOrgs(token);

    if (!orgs) {
      return Response.json(
        { error: "Failed to fetch organizations" },
        { status: 500 },
      );
    }

    return Response.json(orgs);
  } catch (error) {
    console.error("Error fetching organizations:", error);
    return Response.json(
      { error: "Failed to fetch organizations" },
      { status: 500 },
    );
  }
}
