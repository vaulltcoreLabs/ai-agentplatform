import { ProjectsContent } from "@/components/projects/projects-content";
import { RequireAuth } from "@/src/auth-guard";

export function ProjectsRoute() {
  return (
    <RequireAuth>
      <ProjectsContent />
    </RequireAuth>
  );
}
