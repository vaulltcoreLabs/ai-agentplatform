import { Navigate } from "react-router-dom";

export function SettingsIndexRoute() {
  return <Navigate to="/settings/profile" replace />;
}
