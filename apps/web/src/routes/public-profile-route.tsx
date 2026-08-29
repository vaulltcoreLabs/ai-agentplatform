import { Navigate, useParams } from "react-router-dom";
import { PublicUsageView } from "@/app/[username]/public-usage-view";

export function PublicProfileRoute() {
  const { username } = useParams<{ username: string }>();

  if (!username) {
    return <Navigate to="/" replace />;
  }

  return <PublicUsageView username={username} />;
}
