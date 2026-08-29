import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { useSession } from "@/hooks/use-session";
import { GetStartedFlow } from "@/app/get-started/get-started-flow";

export function GetStartedRoute() {
  const { loading, isAuthenticated } = useSession();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const _requestedStep = searchParams.get("step");

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  }

  return <GetStartedFlow />;
}
