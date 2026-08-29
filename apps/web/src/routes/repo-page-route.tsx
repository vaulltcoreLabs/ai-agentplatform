import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { RequireAuth } from "@/src/auth-guard";
import { useSession } from "@/hooks/use-session";

export function RepoPageRoute() {
  const { username, repo } = useParams<{ username: string; repo: string }>();
  const { loading, isAuthenticated } = useSession();
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !username || !repo) return;

    async function createSession() {
      try {
        const res = await fetch(
          `/api/repos/${username}/${repo}/create-session`,
          {
            method: "POST",
          },
        );

        if (res.status === 403) {
          const data = await res.json();
          if (data.trialRedirect) {
            setRedirectUrl(data.trialRedirect);
          } else {
            setError("Access denied");
          }
          return;
        }

        if (!res.ok) {
          if (res.status === 404) {
            setError("Repository not found");
          } else {
            setError("Failed to create session");
          }
          return;
        }

        const data = await res.json();
        if (data.session && data.chat) {
          setRedirectUrl(`/sessions/${data.session.id}/chats/${data.chat.id}`);
        }
      } catch {
        setError("Failed to create session");
      }
    }

    void createSession();
  }, [isAuthenticated, username, repo]);

  if (loading) {
    return (
      <RequireAuth>
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-muted-foreground">Loading…</div>
        </div>
      </RequireAuth>
    );
  }

  if (!isAuthenticated) {
    return <RequireAuth>{null}</RequireAuth>;
  }

  if (!username || !repo) {
    return <Navigate to="/" replace />;
  }

  if (redirectUrl) {
    return <Navigate to={redirectUrl} replace />;
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">{error}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-muted-foreground">Creating session…</div>
    </div>
  );
}
