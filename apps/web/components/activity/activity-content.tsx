import { useRouter } from "@/lib/navigation";
import {
  GitBranch,
  GitMerge,
  MessageSquare,
  CheckCircle2,
  XCircle,
  FileUp,
  Plus,
  Clock,
} from "lucide-react";
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

function getActivityIcon(status: string) {
  switch (status) {
    case "running":
      return <GitBranch className="h-3.5 w-3.5 text-emerald-500" />;
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 text-blue-500" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    default:
      return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function getActivityLabel(status: string) {
  switch (status) {
    case "running":
      return "started a session";
    case "completed":
      return "completed a session";
    case "failed":
      return "session encountered an error";
    default:
      return "updated a session";
  }
}

interface ActivityEntry {
  session: SessionWithUnread;
  timestamp: Date;
}

function deriveActivityFeed(sessions: SessionWithUnread[]): ActivityEntry[] {
  return sessions
    .map((s) => ({
      session: s,
      timestamp: new Date(s.lastActivityAt ?? s.createdAt),
    }))
    .sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    )
    .slice(0, 50);
}

function ActivitySkeleton() {
  return (
    <div className="space-y-4 p-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export function ActivityContent() {
  const router = useRouter();
  const { sessions, loading } = useSessions({
    enabled: true,
    includeArchived: true,
  });

  if (loading) {
    return (
      <>
        <header className="border-b border-border px-3 py-2 lg:px-4 lg:py-3">
          <div className="flex min-h-8 items-center gap-2">
            <SidebarTrigger className="shrink-0" />
          </div>
        </header>
        <ActivitySkeleton />
      </>
    );
  }

  const feed = deriveActivityFeed(sessions);

  if (feed.length === 0) {
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
              <EmptyTitle>No activity yet</EmptyTitle>
              <EmptyDescription>
                Activity from your sessions will appear here as you work with
                the AI agent.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <EmptyDescription>
                Start a session to begin building.
              </EmptyDescription>
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
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Recent activity across all your sessions.
            </p>
          </div>
          <div className="space-y-1">
            {feed.map((entry) => {
              const repoLabel =
                entry.session.repoOwner && entry.session.repoName
                  ? `${entry.session.repoOwner}/${entry.session.repoName}`
                  : null;

              return (
                <button
                  key={`${entry.session.id}-${entry.timestamp}`}
                  type="button"
                  onClick={() => {
                    if (entry.session.latestChatId) {
                      router.push(
                        `/sessions/${entry.session.id}/chats/${entry.session.latestChatId}`,
                      );
                    } else {
                      router.push(`/sessions/${entry.session.id}`);
                    }
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="shrink-0">
                    {getActivityIcon(entry.session.status)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-medium">
                        {entry.session.title}
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        — {getActivityLabel(entry.session.status)}
                      </span>
                    </p>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {repoLabel && (
                        <span className="flex items-center gap-1">
                          <GitBranch className="h-3 w-3" />
                          {repoLabel}
                        </span>
                      )}
                      {entry.session.prNumber && (
                        <span className="flex items-center gap-1">
                          <GitMerge className="h-3 w-3" />
                          PR #{entry.session.prNumber}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(entry.timestamp)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
