import { getInstallationsByUserId } from "@/lib/db/installations";
import { getInstallationManageUrl } from "@/lib/github/urls";
import { getServerSession } from "@/lib/session/get-server-session";

export async function GET(req: Request) {
  const session = await getServerSession(req.headers);

  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const installations = await getInstallationsByUserId(session.user.id);

    return Response.json(
      installations.map((installation) => ({
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: installation.repositorySelection,
        installationUrl: getInstallationManageUrl(
          installation.installationId,
          installation.installationUrl,
        ),
      })),
    );
  } catch (error) {
    console.error("Failed to fetch GitHub installations:", error);
    return Response.json(
      { error: "Failed to fetch installations" },
      { status: 500 },
    );
  }
}
