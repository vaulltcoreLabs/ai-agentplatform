import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { RequireAuth } from "@/src/auth-guard";
import { useSession } from "@/hooks/use-session";

interface ChatsResponse {
  chats: Array<{ id: string }>;
}

function fetcher(url: string): Promise<ChatsResponse> {
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error("Failed to load");
    return res.json();
  });
}

export function SessionRedirectRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { loading, isAuthenticated } = useSession();
  const [targetChatId, setTargetChatId] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || !sessionId) return;

    let cancelled = false;

    fetcher(`/api/sessions/${sessionId}/chats`)
      .then((data) => {
        if (cancelled) return;

        if (data.chats?.length > 0) {
          setTargetChatId(data.chats[0].id);
        } else {
          setNotFound(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNotFound(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, sessionId]);

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

  if (notFound) {
    return <Navigate to="/sessions" replace />;
  }

  if (targetChatId) {
    return (
      <Navigate to={`/sessions/${sessionId}/chats/${targetChatId}`} replace />
    );
  }

  return (
    <div className="flex h-dvh items-center justify-center">
      <div className="text-muted-foreground">Loading session…</div>
    </div>
  );
}
