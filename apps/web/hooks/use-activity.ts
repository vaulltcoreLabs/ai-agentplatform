import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import type { SessionWithUnread } from "@/hooks/use-sessions";

interface SessionsResponse {
  sessions: SessionWithUnread[];
}

export function useActivity(limit?: number) {
  const { data, error, isLoading } = useSWR<SessionsResponse>(
    "/api/sessions",
    fetcher,
    {
      refreshInterval: 30_000,
    },
  );

  const activities = (data?.sessions ?? [])
    .slice(0, limit ?? 50)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  return {
    activities,
    loading: isLoading,
    error,
  };
}
