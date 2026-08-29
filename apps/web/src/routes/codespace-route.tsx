import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { RequireAuth } from "@/src/auth-guard";
import { useSession } from "@/hooks/use-session";
import type { Session } from "@/lib/db/schema";
import { CodespaceProvider } from "@/app/codespace/[sessionId]/codespace-context";
import CodespacePage from "@/app/codespace/[sessionId]/page";

interface SessionResponse {
  session: Session;
}

export function CodespaceRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { loading, isAuthenticated, session: authSession } = useSession();

  const [sessionRecord, setSessionRecord] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !sessionId) return;

    let cancelled = false;

    async function fetchData() {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`);
        if (!res.ok) {
          if (res.status === 404) {
            setError("not-found");
          } else if (res.status === 403) {
            setError("redirect-home");
          } else {
            setError("error");
          }
          return;
        }
        const data: SessionResponse = await res.json();
        if (cancelled) return;

        if (data.session.userId !== authSession?.user?.id) {
          setError("redirect-home");
          return;
        }

        setSessionRecord(data.session);
      } catch {
        if (!cancelled) {
          setError("error");
        }
      }
    }

    void fetchData();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, sessionId, authSession?.user?.id]);

  if (loading) {
    return (
      <RequireAuth>
        <div className="flex h-dvh items-center justify-center">
          <div className="text-muted-foreground">Loading…</div>
        </div>
      </RequireAuth>
    );
  }

  if (!isAuthenticated) {
    return <RequireAuth>{null}</RequireAuth>;
  }

  if (!sessionId) {
    return <Navigate to="/sessions" replace />;
  }

  if (error === "redirect-home") {
    return <Navigate to="/sessions" replace />;
  }

  if (error === "not-found") {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="text-muted-foreground">Session not found</div>
      </div>
    );
  }

  if (!sessionRecord) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="text-muted-foreground">Loading…</div>
      </div>
    );
  }

  return (
    <CodespaceProvider
      sessionTitle={sessionRecord.title}
      repoName={sessionRecord.repoName}
      repoOwner={sessionRecord.repoOwner}
      branch={sessionRecord.branch}
      cloneUrl={sessionRecord.cloneUrl}
    >
      <CodespacePage />
    </CodespaceProvider>
  );
}
