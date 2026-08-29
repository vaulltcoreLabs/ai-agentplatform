import { useCallback, useState } from "react";
import {
  Download,
  Trash2,
  FileIcon,
  ExternalLink,
  Loader2,
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
import {
  useArtifacts,
  type ArtifactMeta,
} from "@/hooks/use-artifacts";
import { toast } from "sonner";

function formatByteSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function getContentTypeLabel(contentType: string): string {
  const map: Record<string, string> = {
    "application/pdf": "PDF",
    "image/png": "PNG",
    "image/jpeg": "JPEG",
    "image/gif": "GIF",
    "image/webp": "WebP",
    "application/zip": "ZIP",
    "application/json": "JSON",
    "text/plain": "Text",
    "text/csv": "CSV",
    "application/octet-stream": "File",
  };
  return map[contentType] ?? contentType.split("/")[1]?.toUpperCase() ?? "File";
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

function ArtifactCard({
  artifact,
  onDownload,
  onDelete,
}: {
  artifact: ArtifactMeta;
  onDownload: (artifactId: string) => Promise<void>;
  onDelete: (artifactId: string) => Promise<void>;
}) {
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      await onDownload(artifact.artifactId);
    } finally {
      setDownloading(false);
    }
  }, [artifact.artifactId, onDownload]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await onDelete(artifact.artifactId);
    } finally {
      setDeleting(false);
    }
  }, [artifact.artifactId, onDelete]);

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
          <span>{getContentTypeLabel(artifact.contentType)}</span>
          <span>{formatByteSize(artifact.byteSize)}</span>
          {artifact.sha256 && (
            <span className="font-mono">
              sha256:{artifact.sha256.slice(0, 8)}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        {artifact.lifecycle === "READY" && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleDownload}
            disabled={downloading}
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
            onClick={handleDelete}
            disabled={deleting}
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

function ArtifactListSkeleton() {
  return (
    <div className="space-y-2">
      {[1, 2].map((i) => (
        <Skeleton key={i} className="h-16 rounded-lg" />
      ))}
    </div>
  );
}

export function ArtifactList({ runId }: { runId: string }) {
  const { artifacts, loading, downloadArtifact, deleteArtifact } =
    useArtifacts(runId);

  const handleDownload = useCallback(
    async (artifactId: string) => {
      const result = await downloadArtifact(artifactId);
      if (result?.downloadUrl) {
        window.open(result.downloadUrl, "_blank");
        toast.success("Download started");
      } else {
        toast.error("Download failed");
      }
    },
    [downloadArtifact],
  );

  const handleDelete = useCallback(
    async (artifactId: string) => {
      const success = await deleteArtifact(artifactId);
      if (success) {
        toast.success("Artifact deleted");
      } else {
        toast.error("Delete failed");
      }
    },
    [deleteArtifact],
  );

  if (loading) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Artifacts</h3>
        <ArtifactListSkeleton />
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Artifacts</h3>
        <Empty className="min-h-32">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileIcon />
            </EmptyMedia>
            <EmptyTitle>No artifacts yet</EmptyTitle>
            <EmptyDescription>
              Artifacts will appear here when the agent generates files or
              outputs.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const readyArtifacts = artifacts.filter((a) => a.lifecycle === "READY");
  const otherArtifacts = artifacts.filter((a) => a.lifecycle !== "READY");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          Artifacts ({artifacts.length})
        </h3>
        {readyArtifacts.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {readyArtifacts.length} ready
          </span>
        )}
      </div>
      <div className="space-y-2">
        {readyArtifacts.map((artifact) => (
          <ArtifactCard
            key={artifact.artifactId}
            artifact={artifact}
            onDownload={handleDownload}
            onDelete={handleDelete}
          />
        ))}
        {otherArtifacts.map((artifact) => (
          <ArtifactCard
            key={artifact.artifactId}
            artifact={artifact}
            onDownload={handleDownload}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  );
}
