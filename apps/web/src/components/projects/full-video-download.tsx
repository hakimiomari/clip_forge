"use client";

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, RefreshCcw } from "lucide-react";
import type { SourceDownloadInfo } from "@clipforge/shared-types";
import { api, ApiError } from "@/lib/api";
import { formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/input";
import { ProgressBar } from "@/components/ui/progress";

const WORKING = ["PENDING", "DOWNLOADING", "SAVING"];

/** Hands a URL to the browser as a download, as if a link was clicked. */
function saveFile(url: string, fileName: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * The project's complete source video. An upload downloads straight
 * away; a YouTube import is fetched in full first (clips only ever fetch
 * their own sections), then saved to the browser as soon as it's ready.
 */
export function FullVideoDownload({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["source-download", projectId];
  // Set when this page asked for the video, so it is saved the moment it
  // is ready — but not when an old, already-finished one is merely shown
  const saveWhenReady = useRef(false);

  const { data: info, isLoading } = useQuery({
    queryKey,
    queryFn: () => api<SourceDownloadInfo>(`/projects/${projectId}/source/download`),
    refetchInterval: (query) =>
      WORKING.includes(query.state.data?.status ?? "") ? 2000 : false,
  });

  const prepare = useMutation({
    mutationFn: () =>
      api<SourceDownloadInfo>(`/projects/${projectId}/source/download`, { method: "POST" }),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  });

  useEffect(() => {
    if (saveWhenReady.current && info?.status === "READY" && info.url) {
      saveWhenReady.current = false;
      saveFile(info.url, info.fileName);
    }
  }, [info]);

  if (isLoading || !info) {
    return (
      <Card>
        <CardTitle className="mb-3">Full video</CardTitle>
        <Loader2 className="h-4 w-4 animate-spin text-muted" />
      </Card>
    );
  }

  const fromYouTube = info.sourceType === "YOUTUBE";
  const working = WORKING.includes(info.status);
  const details = [
    info.width && info.height ? `${info.width}×${info.height}` : null,
    "MP4",
    info.sizeBytes ? formatBytes(info.sizeBytes) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card>
      <CardTitle className="mb-1">Full video</CardTitle>
      <p className="mb-3 text-xs text-muted">
        {fromYouTube
          ? "The complete video from YouTube, up to 1080p."
          : "The original file you uploaded."}
      </p>

      {info.status === "READY" && info.url && (
        <>
          <a href={info.url} download={info.fileName} className="block">
            <Button className="w-full">
              <Download className="h-4 w-4" />
              Download full video
            </Button>
          </a>
          <p className="mt-2 text-center text-xs text-muted">{details}</p>
        </>
      )}

      {working && (
        <ProgressBar
          value={info.status === "PENDING" ? 0 : info.progress}
          label={
            info.status === "PENDING"
              ? "Waiting to start…"
              : info.status === "SAVING"
                ? "Saving the video…"
                : `Downloading from YouTube (${info.progress}%)`
          }
        />
      )}

      {(info.status === "NONE" || info.status === "FAILED") && fromYouTube && (
        <>
          {info.status === "FAILED" && (
            <p className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {info.error ?? "The download failed."}
            </p>
          )}
          <Button
            className="w-full"
            variant={info.status === "FAILED" ? "secondary" : "primary"}
            loading={prepare.isPending}
            onClick={() => {
              saveWhenReady.current = true;
              prepare.mutate();
            }}
          >
            {info.status === "FAILED" ? (
              <RefreshCcw className="h-4 w-4" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {info.status === "FAILED" ? "Try the download again" : "Download full video"}
          </Button>
          <p className="mt-2 text-center text-xs text-muted">
            Free. A long video takes a few minutes to fetch; it saves to your
            computer as soon as it's ready, and stays here for next time.
          </p>
        </>
      )}

      {info.status === "NONE" && !fromYouTube && (
        <p className="text-xs text-muted">The original file isn't available.</p>
      )}

      <FieldError
        message={
          prepare.error
            ? prepare.error instanceof ApiError
              ? prepare.error.message
              : String(prepare.error)
            : undefined
        }
      />
    </Card>
  );
}
