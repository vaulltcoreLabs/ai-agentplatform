import useSWR from "swr";
import { fetcher } from "@/lib/swr";

export interface RepoInfo {
  owner: string;
  name: string;
  fullName: string;
  sessionCount: number;
  lastSessionAt: string;
  latestSessionStatus: string;
  latestSessionTitle: string;
  branches: string[];
}

interface SessionsApiResponse {
  sessions: Array<{
    id: string;
    title: string;
    status: string;
    repoOwner: string | null;
    repoName: string | null;
    branch: string | null;
    createdAt: string;
  }>;
}

export function useRepos() {
  const { data, error, isLoading } = useSWR<SessionsApiResponse>(
    "/api/sessions",
    fetcher,
  );

  const sessions = data?.sessions ?? [];
  const repoMap = new Map<string, RepoInfo>();

  for (const session of sessions) {
    if (!session.repoOwner || !session.repoName) continue;
    const key = `${session.repoOwner}/${session.repoName}`;
    const existing = repoMap.get(key);

    if (!existing) {
      repoMap.set(key, {
        owner: session.repoOwner,
        name: session.repoName,
        fullName: key,
        sessionCount: 1,
        lastSessionAt: session.createdAt,
        latestSessionStatus: session.status,
        latestSessionTitle: session.title,
        branches: session.branch ? [session.branch] : [],
      });
    } else {
      existing.sessionCount += 1;
      if (
        new Date(session.createdAt).getTime() >
        new Date(existing.lastSessionAt).getTime()
      ) {
        existing.lastSessionAt = session.createdAt;
        existing.latestSessionStatus = session.status;
        existing.latestSessionTitle = session.title;
      }
      if (session.branch && !existing.branches.includes(session.branch)) {
        existing.branches.push(session.branch);
      }
    }
  }

  const repos = Array.from(repoMap.values()).sort(
    (a, b) =>
      new Date(b.lastSessionAt).getTime() - new Date(a.lastSessionAt).getTime(),
  );

  return {
    repos,
    loading: isLoading,
    error,
  };
}
