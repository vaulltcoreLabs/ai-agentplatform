import { generateState } from "arctic";
import { getInstallationsByUserId } from "@/lib/db/installations";
import { syncUserInstallations } from "@/lib/github/sync";
import { getUserGitHubToken } from "@/lib/github/token";
import {
  getGitHubAccountId,
  getGitHubUsername,
  hasGitHubAccount,
} from "@/lib/github/users";
import { isManagedTemplateTrialUser } from "@/lib/managed-template-trial";
import { sanitizeInternalRedirect } from "@/lib/redirect-safety";
import { getServerSession } from "@/lib/session/get-server-session";

const COOKIE_OPTIONS = {
  path: "/",
  secure: process.env.NODE_ENV === "production",
  httpOnly: true,
  maxAge: 60 * 15,
  sameSite: "lax" as const,
};

function serializeCookie(name: string, value: string): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${COOKIE_OPTIONS.path}`,
    `Secure=${COOKIE_OPTIONS.secure}`,
    `HttpOnly`,
    `Max-Age=${COOKIE_OPTIONS.maxAge}`,
    `SameSite=${COOKIE_OPTIONS.sameSite}`,
  ];
  return parts.join("; ");
}

function redirectWithInstallCookies(
  url: string | URL,
  redirectTo: string,
  state: string,
): Response {
  const headers = new Headers();
  headers.set(
    "Set-Cookie",
    [
      serializeCookie("github_app_install_redirect_to", redirectTo),
      serializeCookie("github_app_install_state", state),
    ].join(", "),
  );
  return new Response(null, {
    status: 307,
    headers: { ...headers, Location: url.toString() },
  });
}

export async function GET(req: Request): Promise<Response> {
  const session = await getServerSession(req.headers);
  const redirectTo = sanitizeInternalRedirect(
    new URL(req.url).searchParams.get("next"),
    "/get-started",
    req.url,
  );

  if (!session?.user?.id) {
    return Response.redirect(new URL("/", req.url), 307);
  }

  if (isManagedTemplateTrialUser(session, req.url)) {
    const fallbackUrl = new URL(redirectTo, req.url);
    fallbackUrl.searchParams.set("github", "trial_blocked");
    return Response.redirect(fallbackUrl, 307);
  }

  const appSlug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
  if (!appSlug) {
    const fallbackUrl = new URL(redirectTo, req.url);
    fallbackUrl.searchParams.set("github", "app_not_configured");
    return Response.redirect(fallbackUrl, 307);
  }

  const state = generateState();

  // if a specific target_id is provided, go directly to install for that account
  const targetId = new URL(req.url).searchParams.get("target_id");
  if (targetId && /^\d+$/.test(targetId)) {
    const installUrl = new URL(
      `https://github.com/apps/${appSlug}/installations/new/permissions`,
    );
    installUrl.searchParams.set("state", state);
    installUrl.searchParams.set("target_id", targetId);
    return redirectWithInstallCookies(installUrl, redirectTo, state);
  }

  // no linked github account — redirect to get-started to connect first
  const linked = await hasGitHubAccount(session.user.id);
  if (!linked) {
    const connectUrl = new URL("/get-started", req.url);
    connectUrl.searchParams.set("github", "not_linked");
    connectUrl.searchParams.set("next", redirectTo);
    return Response.redirect(connectUrl, 307);
  }

  // reconnect mode — skip account picker, target the user's personal account
  const reconnect = new URL(req.url).searchParams.get("reconnect");
  if (reconnect === "1") {
    const accountId = await getGitHubAccountId(session.user.id);
    if (accountId) {
      const installUrl = new URL(
        `https://github.com/apps/${appSlug}/installations/new/permissions`,
      );
      installUrl.searchParams.set("state", state);
      installUrl.searchParams.set("target_id", accountId);
      return redirectWithInstallCookies(installUrl, redirectTo, state);
    }
  }

  // try to sync installations
  let installations = await getInstallationsByUserId(session.user.id);

  if (installations.length === 0) {
    try {
      const token = await getUserGitHubToken(session.user.id);
      const username = await getGitHubUsername(session.user.id);
      if (token && username) {
        await syncUserInstallations(session.user.id, token, username);
        installations = await getInstallationsByUserId(session.user.id);
      }
    } catch (error) {
      console.error("Failed to sync GitHub installations in install flow:", {
        userId: session.user.id,
        error,
      });
    }
  }

  if (installations.length === 0) {
    // no installations — route to install page
    const installUrl = new URL(
      `https://github.com/apps/${appSlug}/installations/new/permissions`,
    );
    installUrl.searchParams.set("state", state);
    return redirectWithInstallCookies(installUrl, redirectTo, state);
  }

  // already has installations — show account/org picker for additional installs
  const installUrl = new URL(
    `https://github.com/apps/${appSlug}/installations/select_target`,
  );
  installUrl.searchParams.set("state", state);
  return redirectWithInstallCookies(installUrl, redirectTo, state);
}
