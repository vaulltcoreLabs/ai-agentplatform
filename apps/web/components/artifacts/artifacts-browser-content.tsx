import { useCallback, useMemo, useState } from "react";
import {
  Download,
  Trash2,
  FileIcon,
  Loader2,
  FolderOpen,
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
import { toast } from "sonner";
import { useSessions } from "@/hooks/use-sessions";
import {
  useArtifacts,
  type ArtifactMeta,
} from "@/hooks/use-artifacts";

function formatByteSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

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

function LifecycleBadge({
  lifecycle,
}: {
  lifecycle: ArtifactMeta["lifecycle"];
}) {
  switch (lifecycle) {
    case "READY":
      return (
        <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">
          Ready
        </span>
      );
    case "UPLOADING":
      return (
        <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-500">
          Uploading
        </span>
      );
    case "RESERVED":
      return (
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          Reserved
        </span>
      );
    case "FAILED":
      return (
        <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
          Failed
        </span>
      );
    case "DELETING":
      return (
        <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-500">
          Deleting
        </span>
      );
    case "DELETED":
      return (
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground line-through">
          Deleted
        </span>
      );
    default:
      return null;
  }
}

function ArtifactRow({
  artifact,
  sessionTitle,
  onDownload,
  onDelete,
}: {
  artifact: ArtifactMeta;
  sessionTitle: string;
  onDownload: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card px-4 py-3 transition-colors hover:border-border">
      <div className="rounded-lg bg-muted p-2">
        <FileIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {artifact.artifactId}
          </span>
          <LifecycleBadge lifecycle={artifact.lifecycle} />
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
          <span>{formatByteSize(artifact.byteSize)}</span>
          <span>{sessionTitle}</span>
          <span>{formatRelativeTime(new Date(artifact.createdAt))}</span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {artifact.lifecycle === "READY" && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={downloading}
            onClick={async () => {
              setDownloading(true);
              try {
                await onDownload(artifact.artifactId);
              } finally {
                setDownloading(false);
              }
            }}
            title="Download"
          >
            {downloading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </Button>
        )}
        {(artifact.lifecycle === "READY" ||
          artifact.lifecycle === "FAILED" ||
          artifact.lifecycle === "RESERVED") && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            disabled={deleting}
            onClick={async () => {
              setDeleting(true);
              try {
                await onDelete(artifact.artifactId);
              } finally {
                setDeleting(false);
              }
            }}
            title="Delete"
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

function ArtifactBrowserSkeleton() {
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

export function ArtifactsBrowserContent() {
  const { sessions, loading: sessionsLoading } = useSessions({
    enabled: true,
    includeArchived: true,
  });

  // Collect all session IDs that have artifacts
  const sessionIds = useMemo(
    () => sessions.map((s) => s.id),
    [sessions],
  );

  const sessionTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      map.set(s.id, s.title);
    }
    return map;
  }, [sessions]);

  // Aggregate artifacts from all sessions (each hook fetches per-run)
  const allArtifactSets = sessionIds.map((id) => useArtifacts(id));

  const loading = sessionsLoading || allArtifactSets.some((a) => a.loading);

  const allArtifacts = useMemo(() => {
    const items: Array<ArtifactMeta & { sessionTitle: string }> = [];
    for (const artifactSet of allArtifactSets) {
      for (const artifact of artifactSet.artifacts) {
        items.push({
          ...artifact,
          sessionTitle: sessionTitleMap.get(artifact.runId) ?? "Unknown session",
        });
      }
    }
    return items.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [allArtifactSets, sessionTitleMap]);

  const handleDownload = useCallback(
    async (artifactId: string) => {
      const artifact = allArtifacts.find((a) => a.artifactId === artifactId);
      if (!artifact) return;
      const hook = allArtifactSets.find(
        (h) => h.artifacts.some((a) => a.artifactId === artifactId),
      );
      if (!hook) return;
      const result = await hook.downloadArtifact(artifactId);
      if (result?.downloadUrl) {
        window.open(result.downloadUrl, "_blank");
        toast.success("Download started");
      } else {
        toast.error("Download failed");
      }
    },
    [allArtifacts, allArtifactSets],
  );

  const handleDelete = useCallback(
    async (artifactId: string) => {
      const hook = allArtifactSets.find(
        (h) => h.artifacts.some((a) => a.artifactId === artifactId),
      );
      if (!hook) return;
      const success = await hook.deleteArtifact(artifactId);
      if (success) {
        toast.success("Artifact deleted");
      } else {
        toast.error("Delete failed");
      }
    },
    [allArtifactSets],
  );

  if (loading) {
    return (
      <>
        <header className="border-b border-border px-3 py-2 lg:px-4 lg:py-3">
          <div className="flex min-h-8 items-center gap-2">
            <SidebarTrigger className="shrink-0" />
          </div>
        </header>
        <ArtifactBrowserSkeleton />
      </>
    );
  }

  if (allArtifacts.length === 0) {
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
                <FolderOpen />
              </EmptyMedia>
              <EmptyTitle>No artifacts yet</EmptyTitle>
              <EmptyDescription>
                Artifacts will appear here when the agent generates files,
                documents, or outputs.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </>
    );
  }

  const readyCount = allArtifacts.filter((a) => a.lifecycle === "READY").length;

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
            <h1 className="text-2xl font-semibold tracking-tight">Artifacts</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {allArtifacts.length} artifact{allArtifacts.length === 1 ? "" : "s"} across all sessions
              {readyCount > 0 && ` · ${readyCount} ready`}
            </p>
          </div>
          <div className="space-y-2">
            {allArtifacts.map((artifact) => (
              <ArtifactRow
                key={artifact.artifactId}
                artifact={artifact}
                sessionTitle={artifact.sessionTitle}
                onDownload={handleDownload}
                onDelete={handleDelete}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
