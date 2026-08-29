import { ActivityContent } from "@/components/activity/activity-content";
import { RequireAuth } from "@/src/auth-guard";

export function ActivityRoute() {
  return (
    <RequireAuth>
      <ActivityContent />
    </RequireAuth>
  );
}
