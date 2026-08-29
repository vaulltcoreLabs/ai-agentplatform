import { Outlet } from "react-router-dom";
import SettingsLayout from "@/app/settings/layout";

export function SettingsLayoutRoute() {
  return (
    <SettingsLayout>
      <Outlet />
    </SettingsLayout>
  );
}
