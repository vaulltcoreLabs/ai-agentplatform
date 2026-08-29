import { getInstallationsByUserId } from "@/lib/db/installations";
import type { GitHubConnectionStatusResponse } from "@/lib/github/status";
import {
  isGitHubInstallationsAuthError,
  syncUserInstallations,
} from "@/lib/github/sync";
import { getUserGitHubToken } from "@/lib/github/token";
import { getGitHubUsername, hasGitHubAccount } from "@/lib/github/users";
import { getServerSession } from "@/lib/session/get-server-session";

export async function GET(req: Request) {
  const session = await getServerSession(req.headers);

  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const [linked, installations] = await Promise.all([
    hasGitHubAccount(session.user.id),
    getInstallationsByUserId(session.user.id),
  ]);

  if (!linked) {
    return Response.json({
      status: "not_connected",
      reason: null,
      hasInstallations: installations.length > 0,
      syncedInstallationsCount: installations.length,
    } satisfies GitHubConnectionStatusResponse);
  }

  const token = await getUserGitHubToken(session.user.id);
  if (!token) {
    return Response.json({
      status: "reconnect_required",
      reason: "token_unavailable",
      hasInstallations: installations.length > 0,
      syncedInstallationsCount: null,
    } satisfies GitHubConnectionStatusResponse);
  }

  try {
    const username = await getGitHubUsername(session.user.id);
    if (!username) {
      return Response.json({
        status: "reconnect_required",
        reason: "sync_auth_failed",
        hasInstallations: installations.length > 0,
        syncedInstallationsCount: null,
      } satisfies GitHubConnectionStatusResponse);
    }

    const syncedInstallationsCount = await syncUserInstallations(
      session.user.id,
      token,
      username,
    );
    const reconnectRequired =
      installations.length > 0 && syncedInstallationsCount === 0;

    return Response.json({
      status: reconnectRequired ? "reconnect_required" : "connected",
      reason: reconnectRequired ? "installations_missing" : null,
      hasInstallations: syncedInstallationsCount > 0,
      syncedInstallationsCount,
    } satisfies GitHubConnectionStatusResponse);
  } catch (error) {
    if (isGitHubInstallationsAuthError(error)) {
      return Response.json({
        status: "reconnect_required",
        reason: "sync_auth_failed",
        hasInstallations: installations.length > 0,
        syncedInstallationsCount: null,
      } satisfies GitHubConnectionStatusResponse);
    }

    console.error("Failed to validate GitHub connection status:", error);

    return Response.json({
      status: "connected",
      reason: null,
      hasInstallations: installations.length > 0,
      syncedInstallationsCount: installations.length,
    } satisfies GitHubConnectionStatusResponse);
  }
}
