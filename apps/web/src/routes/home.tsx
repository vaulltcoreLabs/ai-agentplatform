import { Navigate, useLocation } from "react-router-dom";
import { HomePage } from "@/app/home-page";
import { useSession } from "@/hooks/use-session";

export function HomeRoute() {
  const { loading, isAuthenticated } = useSession();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (isAuthenticated) {
    return (
      <Navigate to="/sessions" replace state={{ from: location.pathname }} />
    );
  }

  return <HomePage hasSessionCookie={false} lastRepo={null} />;
}
