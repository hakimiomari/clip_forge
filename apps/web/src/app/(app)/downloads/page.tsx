"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, RefreshCcw, Trash2 } from "lucide-react";
import {
  DOWNLOAD_QUALITIES,
  type DownloadQuality,
  type DownloadSummary,
} from "@clipforge/shared-types";
import { api, ApiError } from "@/lib/api";
import { cn, formatBytes, formatDuration, formatRelativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardDescription } from "@/components/ui/card";
import { Input, Label, FieldError } from "@/components/ui/input";
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

function looksLikeYouTube(url: string): boolean {
  return /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(url.trim());
}

export default function DownloadsPage() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [quality, setQuality] = useState<DownloadQuality>("1080p");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Downloads started from this page are saved to the computer the
  // moment they finish; older finished ones only get a button
  const saveWhenReady = useRef(new Set<string>());

  const { data: items, isLoading } = useQuery({
    queryKey: ["downloads"],
    queryFn: () => api<DownloadSummary[]>("/downloads"),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((d) => WORKING.includes(d.status)) ? 2000 : false,
  });

  useEffect(() => {
    for (const item of items ?? []) {
      if (item.status === "READY" && item.fileUrl && saveWhenReady.current.has(item.id)) {
        saveWhenReady.current.delete(item.id);
        saveFile(item.fileUrl, item.fileName);
      }
    }
  }, [items]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["downloads"] });
  const showError = (err: unknown) =>
    setError(err instanceof ApiError ? err.message : String(err));

  const create = useMutation({
    mutationFn: () =>
      api<DownloadSummary>("/downloads", {
        method: "POST",
        body: { url: url.trim(), quality, rightsConfirmed },
      }),
    onSuccess: (created) => {
      setError(null);
      setUrl("");
      saveWhenReady.current.add(created.id);
      void refresh();
    },
    onError: showError,
  });

  const retry = useMutation({
    mutationFn: (id: string) => api<DownloadSummary>(`/downloads/${id}/retry`, { method: "POST" }),
    onSuccess: (item) => {
      setError(null);
      saveWhenReady.current.add(item.id);
      void refresh();
    },
    onError: showError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/downloads/${id}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
  });

  const submit = () => {
    if (!looksLikeYouTube(url)) {
      setError("Paste a YouTube video link, like https://www.youtube.com/watch?v=…");
      return;
    }
    if (!rightsConfirmed) {
      setError("Please confirm you have the rights or permission to download this video.");
      return;
    }
    create.mutate();
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Download className="h-6 w-6 text-primary" />
          Downloads
        </h1>
        <p className="mt-1 text-sm text-muted">
          Paste a YouTube link to download the complete video. Nothing is added
          to your projects.
        </p>
      </div>

      <Card>
        <Label htmlFor="download-url">YouTube link</Label>
        <Input
          id="download-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />

        <div className="mt-4">
          <Label>Quality</Label>
          <div className="flex flex-wrap gap-2">
            {DOWNLOAD_QUALITIES.map((q) => (
              <button
                key={q.value}
                type="button"
                onClick={() => setQuality(q.value)}
                aria-pressed={quality === q.value}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                  quality === q.value
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted hover:border-border-strong hover:text-foreground",
                )}
              >
                {q.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {DOWNLOAD_QUALITIES.find((q) => q.value === quality)?.hint}
          </p>
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm text-muted-strong">
          <input
            type="checkbox"
            checked={rightsConfirmed}
            onChange={(e) => setRightsConfirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#6d5cff]"
          />
          <span>
            I confirm that I own this video or have permission to download it.
          </span>
        </label>

        <Button
          className="mt-5 w-full"
          onClick={submit}
          loading={create.isPending}
          disabled={url.trim().length < 10}
        >
          <Download className="h-4 w-4" />
          Download video
        </Button>
        <p className="mt-2 text-center text-xs text-muted">
          Free. It saves to your computer as soon as it's ready — a long video
          takes a few minutes. You can close the page; it'll be waiting here.
        </p>
        <FieldError message={error ?? undefined} />
      </Card>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Your downloads</h2>
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        ) : (items ?? []).length === 0 ? (
          <Card>
            <CardDescription>Nothing yet — paste a link above.</CardDescription>
          </Card>
        ) : (
          <div className="space-y-3">
            {(items ?? []).map((item) => (
              <DownloadRow
                key={item.id}
                item={item}
                onRetry={() => retry.mutate(item.id)}
                retrying={retry.isPending && retry.variables === item.id}
                onDelete={() => {
                  const working = WORKING.includes(item.status);
                  if (window.confirm(working ? "Cancel this download?" : "Remove this download?")) {
                    saveWhenReady.current.delete(item.id);
                    remove.mutate(item.id);
                  }
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function DownloadRow({
  item,
  onRetry,
  retrying,
  onDelete,
}: {
  item: DownloadSummary;
  onRetry: () => void;
  retrying: boolean;
  onDelete: () => void;
}) {
  const working = WORKING.includes(item.status);
  const qualityLabel = DOWNLOAD_QUALITIES.find((q) => q.value === item.quality)?.label;
  const meta = [
    item.channel,
    item.duration ? formatDuration(item.duration) : null,
    qualityLabel,
    formatRelativeTime(item.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
  const fileDetails = [
    item.width && item.height ? `${item.width}×${item.height}` : null,
    item.quality === "audio" ? "M4A" : "MP4",
    item.sizeBytes ? formatBytes(item.sizeBytes) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="p-4">
      <div className="flex gap-4">
        <img
          src={item.thumbnailUrl}
          alt=""
          className="h-20 w-36 shrink-0 rounded-md bg-surface-raised object-cover"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{item.title ?? item.url}</p>
              <p className="mt-0.5 truncate text-xs text-muted">{meta}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={onDelete}
              aria-label={working ? "Cancel download" : "Remove download"}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-3">
            {working && (
              <ProgressBar
                value={item.status === "DOWNLOADING" ? item.progress : item.status === "SAVING" ? 100 : 0}
                label={
                  item.status === "PENDING"
                    ? "Waiting to start…"
                    : item.status === "SAVING"
                      ? "Saving…"
                      : `Downloading (${item.progress}%)`
                }
              />
            )}

            {item.status === "READY" && item.fileUrl && (
              <div className="flex flex-wrap items-center gap-3">
                <a href={item.fileUrl} download={item.fileName}>
                  <Button size="sm">
                    <Download className="h-4 w-4" />
                    Save to computer
                  </Button>
                </a>
                <span className="text-xs text-muted">{fileDetails}</span>
              </div>
            )}

            {item.status === "FAILED" && (
              <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-xs text-danger">
                  {item.error ?? "The download failed."}
                </p>
                <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
                  <RefreshCcw className="h-4 w-4" />
                  Try again
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
