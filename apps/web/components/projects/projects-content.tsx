import { useRouter } from "@/lib/navigation";
import {
  GitBranch,
  GitMerge,
  MessageSquare,
  ExternalLink,
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
import { useRepos, type RepoInfo } from "@/hooks/use-repos";

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

function RepoCard({
  repo,
  onClick,
}: {
  repo: RepoInfo;
  onClick: () => void;
}) {
  const statusColor =
    repo.latestSessionStatus === "running"
      ? "bg-emerald-500"
      : repo.latestSessionStatus === "completed"
        ? "bg-muted-foreground"
        : repo.latestSessionStatus === "failed"
          ? "bg-destructive"
          : "bg-muted-foreground/50";

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-4 rounded-lg border border-border/50 bg-card px-4 py-3 text-left transition-colors hover:border-border hover:bg-accent/50"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <GitBranch className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{repo.fullName}</span>
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${statusColor}`}
            aria-label={`Status: ${repo.latestSessionStatus}`}
          />
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            {repo.sessionCount} session{repo.sessionCount === 1 ? "" : "s"}
          </span>
          <span>{formatRelativeTime(new Date(repo.lastSessionAt))}</span>
          {repo.branches.length > 0 && (
            <span className="hidden sm:inline">
              {repo.branches.length === 1
                ? repo.branches[0]
                : `${repo.branches.length} branches`}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <a
          href={`https://github.com/${repo.fullName}`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
          title="Open on GitHub"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        <span className="truncate max-w-[120px] text-xs text-muted-foreground">
          {repo.latestSessionTitle}
        </span>
      </div>
    </button>
  );
}

function ProjectsSkeleton() {
  return (
    <div className="space-y-4 p-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export function ProjectsContent() {
  const router = useRouter();
  const { repos, loading } = useRepos();

  if (loading) {
    return (
      <>
        <header className="border-b border-border px-3 py-2 lg:px-4 lg:py-3">
          <div className="flex min-h-8 items-center gap-2">
            <SidebarTrigger className="shrink-0" />
          </div>
        </header>
        <ProjectsSkeleton />
      </>
    );
  }

  if (repos.length === 0) {
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
                <GitBranch />
              </EmptyMedia>
              <EmptyTitle>No repositories yet</EmptyTitle>
              <EmptyDescription>
                Connect a GitHub repository to start your first engineering
                session.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => router.push("/sessions")}>
                <MessageSquare className="h-4 w-4" />
                Start a session
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
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Repositories
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {repos.length} connected repositories from your sessions.
            </p>
          </div>
          <div className="space-y-2">
            {repos.map((repo) => (
              <RepoCard
                key={repo.fullName}
                repo={repo}
                onClick={() => {
                  const lastSession = repos.find(
                    (r) => r.fullName === repo.fullName,
                  );
                  if (lastSession) {
                    router.push("/sessions");
                  }
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
