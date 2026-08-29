import { getServerSession } from "@/lib/session/get-server-session";
import { getUserGitHubToken } from "@/lib/github/token";
import { fetchGitHubUser } from "@/lib/github/users";

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
    const user = await fetchGitHubUser(token);

    if (!user) {
      return Response.json({ error: "Failed to fetch user" }, { status: 500 });
    }

    return Response.json(user);
  } catch (error) {
    console.error("Error fetching GitHub user:", error);
    return Response.json({ error: "Failed to fetch user" }, { status: 500 });
  }
}
