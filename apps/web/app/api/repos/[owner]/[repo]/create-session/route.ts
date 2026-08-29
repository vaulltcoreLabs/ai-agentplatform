import { nanoid } from "nanoid";
import {
  countSessionsByUserId,
  createSessionWithInitialChat,
  getUsedSessionTitles,
} from "@/lib/db/sessions";
import { getVercelProjectLinkByRepo } from "@/lib/db/vercel-project-links";
import { getUserPreferences } from "@/lib/db/user-preferences";
import { getUserGitHubToken } from "@/lib/github/token";
import {
  isManagedTemplateTrialUser,
  MANAGED_TEMPLATE_TRIAL_GITHUB_SESSION_ERROR,
  MANAGED_TEMPLATE_TRIAL_SESSION_LIMIT,
  MANAGED_TEMPLATE_TRIAL_SESSION_LIMIT_ERROR,
} from "@/lib/managed-template-trial";
import { sanitizeUserPreferencesForSession } from "@/lib/model-access";
import { getRandomCityName } from "@/lib/random-city";
import { getServerSession } from "@/lib/session/get-server-session";

interface GitHubRepoInfo {
  default_branch: string;
  clone_url: string;
  full_name: string;
}

async function fetchRepoInfo(
  owner: string,
  repo: string,
  token?: string,
): Promise<GitHubRepoInfo | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}`,
    { headers },
  );

  if (!response.ok) {
    return null;
  }
  return (await response.json()) as GitHubRepoInfo;
}

type RouteContext = {
  params: Promise<{ owner: string; repo: string }>;
};

export async function POST(req: Request, context: RouteContext) {
  const session = await getServerSession(req.headers);
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { owner, repo } = await context.params;
  const requestHost = new URL(req.url).host;

  if (isManagedTemplateTrialUser(session, requestHost)) {
    const existingSessionCount = await countSessionsByUserId(session.user.id);
    const error =
      existingSessionCount >= MANAGED_TEMPLATE_TRIAL_SESSION_LIMIT
        ? MANAGED_TEMPLATE_TRIAL_SESSION_LIMIT_ERROR
        : MANAGED_TEMPLATE_TRIAL_GITHUB_SESSION_ERROR;
    return Response.json({ error, trialRedirect: "/" }, { status: 403 });
  }

  const [rawPreferences, savedVercelProject] = await Promise.all([
    getUserPreferences(session.user.id),
    getVercelProjectLinkByRepo(session.user.id, owner, repo),
  ]);

  const preferences = sanitizeUserPreferencesForSession(
    rawPreferences,
    session,
    requestHost,
  );

  let token: string | null;
  try {
    token = await getUserGitHubToken(session.user.id);
  } catch {
    token = null;
  }
  const tokenStr = token ?? undefined;

  let repoInfo = tokenStr
    ? await fetchRepoInfo(owner, repo, tokenStr)
    : await fetchRepoInfo(owner, repo);

  if (!repoInfo && tokenStr) {
    repoInfo = await fetchRepoInfo(owner, repo);
  }

  if (!repoInfo) {
    return Response.json({ error: "Repository not found" }, { status: 404 });
  }

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  const usedNames = await getUsedSessionTitles(session.user.id);
  const title = getRandomCityName(usedNames);

  const result = await createSessionWithInitialChat({
    session: {
      id: nanoid(),
      userId: session.user.id,
      title,
      status: "running",
      repoOwner: owner,
      repoName: repo,
      branch: repoInfo.default_branch,
      cloneUrl,
      vercelProjectId: savedVercelProject?.projectId ?? null,
      vercelProjectName: savedVercelProject?.projectName ?? null,
      vercelTeamId: savedVercelProject?.teamId ?? null,
      vercelTeamSlug: savedVercelProject?.teamSlug ?? null,
      isNewBranch: false,
      autoCommitPushOverride: preferences.autoCommitPush,
      autoCreatePrOverride: preferences.autoCommitPush
        ? preferences.autoCreatePr
        : false,
      sandboxState: { type: preferences.defaultSandboxType },
      lifecycleState: "provisioning",
      lifecycleVersion: 0,
    },
    initialChat: {
      id: nanoid(),
      title: "New chat",
      modelId: preferences.defaultModelId,
    },
  });

  return Response.json(result);
}
