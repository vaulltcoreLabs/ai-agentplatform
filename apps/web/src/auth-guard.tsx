import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useSession } from "@/hooks/use-session";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { loading, isAuthenticated } = useSession();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/" state={{ from: location.pathname }} replace />;
  }

  return <>{children}</>;
}

export function useRedirectIfAuthenticated(to: string = "/sessions"): boolean {
  const { loading, isAuthenticated } = useSession();
  const location = useLocation();

  useEffect(() => {
    if (!loading && isAuthenticated) {
      void location.pathname;
      void to;
    }
  }, [loading, isAuthenticated, location, to]);

  return loading;
}
