import { useCallback } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";

export interface ArtifactMeta {
  artifactId: string;
  tenantId: string;
  runId: string;
  objectKey: string;
  lifecycle:
    | "RESERVED"
    | "UPLOADING"
    | "READY"
    | "FAILED"
    | "DELETING"
    | "DELETED";
  contentType: string;
  byteSize: number | null;
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
  uploadedAt: string | null;
  deletedAt: string | null;
}

interface ArtifactsResponse {
  artifacts: ArtifactMeta[];
}

interface DownloadResponse {
  artifactId: string;
  lifecycle: string;
  downloadUrl: string;
}

export function useArtifacts(runId: string | null) {
  const url = runId ? `/api/artifacts?runId=${encodeURIComponent(runId)}` : null;

  const {
    data: response,
    error,
    isLoading,
    mutate,
  } = useSWR<ArtifactsResponse>(url, fetcher, {
    revalidateOnFocus: false,
  });

  const artifacts = response?.artifacts ?? [];

  const downloadArtifact = useCallback(
    async (artifactId: string): Promise<DownloadResponse | null> => {
      if (!runId) return null;
      try {
        const data = await fetcher<DownloadResponse>(
          `/api/artifacts/download/${encodeURIComponent(artifactId)}?runId=${encodeURIComponent(runId)}`,
        );
        return data;
      } catch {
        return null;
      }
    },
    [runId],
  );

  const deleteArtifact = useCallback(
    async (artifactId: string): Promise<boolean> => {
      if (!runId) return false;
      try {
        await fetcher<{ artifactId: string; lifecycle: string }>(
          `/api/artifacts/${encodeURIComponent(artifactId)}?runId=${encodeURIComponent(runId)}`,
        );
        await mutate();
        return true;
      } catch {
        return false;
      }
    },
    [runId, mutate],
  );

  return {
    artifacts,
    loading: isLoading,
    error,
    downloadArtifact,
    deleteArtifact,
    refresh: mutate,
  };
}
