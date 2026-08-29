import { Route, Routes } from "react-router-dom";
import { Suspense } from "react";
import { SessionsLayoutRoute } from "./routes/sessions-route";
import { SessionsIndexRoute } from "./routes/sessions-list-route";
import { SessionRedirectRoute } from "./routes/session-redirect-route";
import { ChatRoute } from "./routes/chat-route";
import { CodespaceRoute } from "./routes/codespace-route";
import { GetStartedRoute } from "./routes/get-started-route";
import { DeployRoute } from "./routes/deploy-route";
import { SettingsLayoutRoute } from "./routes/settings-route";
import { SettingsIndexRoute } from "./routes/settings-index-route";
import { SettingsUsageRoute } from "./routes/settings-usage-route";
import { SettingsProfileRoute } from "./routes/settings-profile-route";
import { SettingsConnectionsRoute } from "./routes/settings-connections-route";
import { SettingsModelsRoute } from "./routes/settings-models-route";
import { SettingsLeaderboardRoute } from "./routes/settings-leaderboard-route";
import { SettingsAdminRoute } from "./routes/settings-admin-route";
import { SettingsPreferencesRoute } from "./routes/settings-preferences-route";
import { SharedChatRoute } from "./routes/shared-chat-route";
import { PublicProfileRoute } from "./routes/public-profile-route";
import { RepoPageRoute } from "./routes/repo-page-route";
import { HomeRoute } from "./routes/home";
import { ProjectsRoute } from "./routes/projects-route";
import { ActivityRoute } from "./routes/activity-route";
import { ArtifactsBrowserRoute } from "./routes/artifacts-browser-route";
import { ErrorState } from "@/components/ui/error-state";

function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <ErrorState variant="not-found" onBack={() => window.history.back()} />
    </div>
  );
}

export function App() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-muted-foreground">Loading…</div>
        </div>
      }
    >
      <Routes>
        <Route path="/" element={<HomeRoute />} />

        <Route path="/sessions" element={<SessionsLayoutRoute />}>
          <Route index element={<SessionsIndexRoute />} />
          <Route path=":sessionId" element={<SessionRedirectRoute />} />
          <Route path=":sessionId/chats/:chatId" element={<ChatRoute />} />
        </Route>

        <Route path="/projects" element={<ProjectsRoute />} />
        <Route path="/activity" element={<ActivityRoute />} />
        <Route path="/artifacts" element={<ArtifactsBrowserRoute />} />

        <Route path="/codespace/:sessionId" element={<CodespaceRoute />} />

        <Route path="/get-started/*" element={<GetStartedRoute />} />

        <Route path="/deploy-your-own" element={<DeployRoute />} />

        <Route path="/settings" element={<SettingsLayoutRoute />}>
          <Route index element={<SettingsIndexRoute />} />
          <Route path="profile" element={<SettingsProfileRoute />} />
          <Route path="connections" element={<SettingsConnectionsRoute />} />
          <Route path="models" element={<SettingsModelsRoute />} />
          <Route path="leaderboard" element={<SettingsLeaderboardRoute />} />
          <Route path="admin" element={<SettingsAdminRoute />} />
          <Route path="preferences" element={<SettingsPreferencesRoute />} />
          <Route path="usage" element={<SettingsUsageRoute />} />
        </Route>

        <Route path="/shared/:shareId" element={<SharedChatRoute />} />

        <Route path="/u/:username" element={<PublicProfileRoute />} />
        <Route path="/u/:username/:repo" element={<RepoPageRoute />} />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
