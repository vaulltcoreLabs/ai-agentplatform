import { syncUserInstallations } from "@/lib/github/sync";
import { getUserGitHubToken } from "@/lib/github/token";
import { getGitHubUsername } from "@/lib/github/users";
import { isManagedTemplateTrialUser } from "@/lib/managed-template-trial";
import { sanitizeInternalRedirect } from "@/lib/redirect-safety";
import { getServerSession } from "@/lib/session/get-server-session";

function parseInstallationId(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const installationId = Number.parseInt(value, 10);
  if (!Number.isFinite(installationId)) {
    return null;
  }

  return installationId;
}

function redirectAndClearCookies(url: string | URL): Response {
  const headers = new Headers();
  const cookiesToClear = [
    "github_app_install_redirect_to",
    "github_app_install_state",
    "github_reconnect",
  ];
  for (const name of cookiesToClear) {
    headers.append(
      "Set-Cookie",
      `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    );
  }
  return new Response(null, {
    status: 307,
    headers: { ...headers, Location: url.toString() },
  });
}

/**
 * GitHub App Setup URL callback — handles installation sync only.
 * OAuth token exchange is handled by better-auth at /api/auth/callback/github.
 */
export async function GET(req: Request): Promise<Response> {
  const cookieHeader = req.headers.get("cookie");
  function getCookieValue(name: string): string | undefined {
    if (!cookieHeader) return undefined;
    const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
    return match ? decodeURIComponent(match[1]!) : undefined;
  }
  const redirectTo = sanitizeInternalRedirect(
    getCookieValue("github_app_install_redirect_to"),
    "/get-started",
    req.url,
  );

  const session = await getServerSession(req.headers);
  if (!session?.user?.id) {
    return Response.redirect(new URL("/", req.url), 307);
  }

  const redirectUrl = new URL(redirectTo, req.url);

  if (isManagedTemplateTrialUser(session, req.url)) {
    redirectUrl.searchParams.set("github", "trial_blocked");
    return redirectAndClearCookies(redirectUrl);
  }

  const requestUrl = new URL(req.url);
  const installationId = parseInstallationId(
    requestUrl.searchParams.get("installation_id"),
  );
  const setupAction = requestUrl.searchParams.get("setup_action");

  // get the user's github token from better-auth
  const token = await getUserGitHubToken(session.user.id);
  if (!token) {
    redirectUrl.searchParams.set("github", "not_linked");
    return redirectAndClearCookies(redirectUrl);
  }

  // sync installations
  let syncedInstallationsCount: number | null = null;
  const username = await getGitHubUsername(session.user.id);

  if (username) {
    try {
      syncedInstallationsCount = await syncUserInstallations(
        session.user.id,
        token,
        username,
      );
    } catch (error) {
      console.error("Failed syncing installations:", error);
    }
  }

  let githubStatus: string;
  if (setupAction === "request") {
    githubStatus = "request_sent";
  } else if ((syncedInstallationsCount ?? 0) > 0) {
    githubStatus = "app_installed";
  } else if (!installationId) {
    githubStatus = "no_action";
    redirectUrl.searchParams.set("missing_installation_id", "1");
  } else {
    githubStatus = "pending_sync";
  }

  redirectUrl.searchParams.set("github", githubStatus);
  return redirectAndClearCookies(redirectUrl);
}
