import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Suspense } from "react";
import { SessionsRouteShell } from "@/app/sessions/sessions-route-shell";
import { useSession } from "@/hooks/use-session";

function SessionsLoadingFallback() {
  return (
    <div className="flex h-dvh items-center justify-center">
      <div className="text-muted-foreground">Loading sessions…</div>
    </div>
  );
}

function SessionsRouteShellContent() {
  const { session, loading } = useSession();
  const location = useLocation();

  if (loading) {
    return <SessionsLoadingFallback />;
  }

  if (!session?.user) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  }

  return (
    <SessionsRouteShell currentUser={session.user} lastRepo={null}>
      <Outlet />
    </SessionsRouteShell>
  );
}

export function SessionsLayoutRoute() {
  return (
    <Suspense fallback={<SessionsLoadingFallback />}>
      <SessionsRouteShellContent />
    </Suspense>
  );
}
