import { ArtifactsBrowserContent } from "@/components/artifacts/artifacts-browser-content";
import { RequireAuth } from "@/src/auth-guard";

export function ArtifactsBrowserRoute() {
  return (
    <RequireAuth>
      <ArtifactsBrowserContent />
    </RequireAuth>
  );
}
