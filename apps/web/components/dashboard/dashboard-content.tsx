import { useRouter } from "@/lib/navigation";
import {
  GitBranch,
  GitMerge,
  MessageSquare,
  Plus,
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
  FolderOpen,
  BarChart3,
  Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useSessions, type SessionWithUnread } from "@/hooks/use-sessions";
import { useSessionsShell } from "@/app/sessions/sessions-shell-context";
import { useUsage, formatTokenCount, formatCost } from "@/hooks/use-usage-stats";

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "running":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Running
        </span>
      );
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          <CheckCircle2 className="h-3 w-3" />
          Completed
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
          <XCircle className="h-3 w-3" />
          Failed
        </span>
      );
    case "archived":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          Archived
        </span>
      );
    default:
      return null;
  }
}

function SessionRow({
  session,
  onClick,
}: {
  session: SessionWithUnread;
  onClick: () => void;
}) {
  const repoLabel = session.repoOwner
    ? `${session.repoOwner}/${session.repoName ?? ""}`
    : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border border-border/50 bg-card px-4 py-3 text-left transition-colors hover:border-border hover:bg-accent/50"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{session.title}</span>
          {session.hasUnread && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          )}
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
          {repoLabel && (
            <span className="flex items-center gap-1 truncate">
              <GitBranch className="h-3 w-3 shrink-0" />
              {repoLabel}
              {session.branch ? ` · ${session.branch}` : ""}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatRelativeTime(new Date(session.createdAt))}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {(session.linesAdded ?? 0) > 0 || (session.linesRemoved ?? 0) > 0 ? (
          <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
            <span className="text-emerald-500">+{session.linesAdded ?? 0}</span>
            {" / "}
            <span className="text-destructive">
              -{session.linesRemoved ?? 0}
            </span>
          </span>
        ) : null}
        {session.prNumber ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <GitMerge className="h-3 w-3" />
            PR #{session.prNumber}
          </span>
        ) : null}
        <StatusBadge status={session.status} />
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
    </button>
  );
}

function QuickLink({
  icon: Icon,
  label,
  href,
  onClick,
}: {
  icon: typeof GitBranch;
  label: string;
  href?: string;
  onClick?: () => void;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={onClick ?? (() => href && router.push(href))}
      className="flex flex-col items-center gap-1.5 rounded-xl border border-border/50 bg-card p-3 transition-colors hover:border-border hover:bg-accent/50"
    >
      <Icon className="h-4 w-4 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">{label}</span>
    </button>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6 p-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export function DashboardContent() {
  const router = useRouter();
  const { openNewSessionDialog } = useSessionsShell();
  const { sessions, loading } = useSessions({
    enabled: true,
    includeArchived: true,
  });
  const { usage } = useUsage();

  if (loading) {
    return (
      <>
        <header className="border-b border-border px-3 py-2 lg:px-4 lg:py-3">
          <div className="flex min-h-8 items-center gap-2">
            <SidebarTrigger className="shrink-0" />
          </div>
        </header>
        <DashboardSkeleton />
      </>
    );
  }

  const activeSessions = sessions.filter((s) => s.status === "running");
  const completedSessions = sessions.filter((s) => s.status === "completed");
  const failedSessions = sessions.filter((s) => s.status === "failed");
  const recentSessions = [...sessions]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, 8);

  const handleSessionClick = (session: SessionWithUnread) => {
    if (session.latestChatId) {
      router.push(`/sessions/${session.id}/chats/${session.latestChatId}`);
    } else {
      router.push(`/sessions/${session.id}`);
    }
  };

  if (sessions.length === 0) {
    return (
      <>
        <header className="border-b border-border px-3 py-2 lg:px-4 lg:py-3">
          <div className="flex min-h-8 items-center gap-2">
            <SidebarTrigger className="shrink-0" />
          </div>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquare />
              </EmptyMedia>
              <EmptyTitle>Welcome to Vaulltcore</EmptyTitle>
              <EmptyDescription>
                Start your first engineering session to begin working with the
                AI agent.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={openNewSessionDialog}>
                <Plus className="h-4 w-4" />
                New Session
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="border-b border-border px-3 py-2 lg:px-4 lg:py-3">
        <div className="flex min-h-8 items-center gap-2">
          <SidebarTrigger className="shrink-0" />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 p-6">
          {/* Header */}
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Dashboard
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Overview of your engineering sessions and activity.
            </p>
          </div>

          {/* Quick links */}
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            <QuickLink
              icon={MessageSquare}
              label="Sessions"
              href="/sessions"
            />
            <QuickLink
              icon={GitBranch}
              label="Repos"
              href="/projects"
            />
            <QuickLink
              icon={Activity}
              label="Activity"
              href="/activity"
            />
            <QuickLink
              icon={FolderOpen}
              label="Artifacts"
              href="/artifacts"
            />
            <QuickLink
              icon={BarChart3}
              label="Usage"
              href="/settings/usage"
            />
            <QuickLink
              icon={Plus}
              label="New Session"
              onClick={openNewSessionDialog}
            />
          </div>

          {/* Stats cards */}
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="rounded-xl border border-border/50 bg-card p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-emerald-500/10 p-2">
                  <MessageSquare className="h-4 w-4 text-emerald-500" />
                </div>
                <div>
                  <p className="text-2xl font-semibold tabular-nums">
                    {sessions.length}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Total Sessions
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-border/50 bg-card p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-blue-500/10 p-2">
                  <CheckCircle2 className="h-4 w-4 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-semibold tabular-nums">
                    {completedSessions.length}
                  </p>
                  <p className="text-xs text-muted-foreground">Completed</p>
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-border/50 bg-card p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-violet-500/10 p-2">
                  <GitBranch className="h-4 w-4 text-violet-500" />
                </div>
                <div>
                  <p className="text-2xl font-semibold tabular-nums">
                    {activeSessions.length}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Active Now
                  </p>
                </div>
              </div>
            </div>
            {usage && (
              <div className="rounded-xl border border-border/50 bg-card p-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-amber-500/10 p-2">
                    <BarChart3 className="h-4 w-4 text-amber-500" />
                  </div>
                  <div>
                    <p className="text-2xl font-semibold tabular-nums">
                      {formatTokenCount(usage.totalTokens)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Tokens Used
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Quick action */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">
              Recent Sessions
            </h2>
            <Button
              variant="outline"
              size="sm"
              onClick={openNewSessionDialog}
            >
              <Plus className="h-3.5 w-3.5" />
              New Session
            </Button>
          </div>

          {/* Session list */}
          <div className="space-y-2">
            {recentSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                onClick={() => handleSessionClick(session)}
              />
            ))}
          </div>

          {/* Failed sessions alert */}
          {failedSessions.length > 0 && (
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
              <h3 className="text-sm font-medium text-destructive">
                {failedSessions.length} session
                {failedSessions.length === 1 ? "" : "s"} need attention
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Some sessions encountered errors. Check the sidebar for details.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
