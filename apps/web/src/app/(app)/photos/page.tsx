"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Images, Loader2, RefreshCcw, Trash2 } from "lucide-react";
import {
  PHOTO_COUNTS,
  PHOTO_MODES,
  type PhotoPickMode,
  type PhotoSetSummary,
} from "@clipforge/shared-types";
import { api, ApiError } from "@/lib/api";
import { cn, formatBytes, formatDuration, formatRelativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardDescription } from "@/components/ui/card";
import { Input, Label, FieldError } from "@/components/ui/input";
import { ProgressBar } from "@/components/ui/progress";

const WORKING = ["PENDING", "FINDING", "CAPTURING", "SAVING"];

function looksLikeYouTube(url: string): boolean {
  return /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(url.trim());
}

/** 754 → "12:34" */
function clock(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export default function PhotosPage() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<PhotoPickMode>("scenes");
  const [count, setCount] = useState<number>(24);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: sets, isLoading } = useQuery({
    queryKey: ["photo-sets"],
    queryFn: () => api<PhotoSetSummary[]>("/photos"),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => WORKING.includes(s.status)) ? 2000 : false,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["photo-sets"] });
  const showError = (err: unknown) =>
    setError(err instanceof ApiError ? err.message : String(err));

  const create = useMutation({
    mutationFn: () =>
      api<PhotoSetSummary>("/photos", {
        method: "POST",
        body: { url: url.trim(), mode, count, rightsConfirmed },
      }),
    onSuccess: () => {
      setError(null);
      setUrl("");
      void refresh();
    },
    onError: showError,
  });

  const retry = useMutation({
    mutationFn: (id: string) => api(`/photos/${id}/retry`, { method: "POST" }),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: showError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/photos/${id}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
  });

  const submit = () => {
    if (!looksLikeYouTube(url)) {
      setError("Paste a YouTube video link, like https://www.youtube.com/watch?v=…");
      return;
    }
    if (!rightsConfirmed) {
      setError("Please confirm you have the rights or permission to use this video.");
      return;
    }
    create.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Images className="h-6 w-6 text-primary" />
          Video to photos
        </h1>
        <p className="mt-1 text-sm text-muted">
          Paste a YouTube link and get full-quality photos spread across the
          whole video. Nothing is added to your projects.
        </p>
      </div>

      <Card>
        <Label htmlFor="photos-url">YouTube link</Label>
        <Input
          id="photos-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <Label>How to pick them</Label>
            <div className="flex flex-wrap gap-2">
              {PHOTO_MODES.map((m) => (
                <Chip key={m.value} active={mode === m.value} onClick={() => setMode(m.value)}>
                  {m.label}
                </Chip>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted">
              {PHOTO_MODES.find((m) => m.value === mode)?.hint}
            </p>
          </div>
          <div>
            <Label>How many</Label>
            <div className="flex flex-wrap gap-2">
              {PHOTO_COUNTS.map((c) => (
                <Chip key={c} active={count === c} onClick={() => setCount(c)}>
                  {c}
                </Chip>
              ))}
            </div>
          </div>
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm text-muted-strong">
          <input
            type="checkbox"
            checked={rightsConfirmed}
            onChange={(e) => setRightsConfirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#6d5cff]"
          />
          <span>I confirm that I own this video or have permission to use it.</span>
        </label>

        <Button
          className="mt-5 w-full"
          onClick={submit}
          loading={create.isPending}
          disabled={url.trim().length < 10}
        >
          <Images className="h-4 w-4" />
          Make photos
        </Button>
        <p className="mt-2 text-center text-xs text-muted">
          Free. Up to 1080p, the video&apos;s own quality. Usually a minute or two;
          &ldquo;Best moments&rdquo; on a long video takes a little longer.
        </p>
        <FieldError message={error ?? undefined} />
      </Card>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Your photo sets</h2>
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        ) : (sets ?? []).length === 0 ? (
          <Card>
            <CardDescription>Nothing yet — paste a link above.</CardDescription>
          </Card>
        ) : (
          <div className="space-y-4">
            {(sets ?? []).map((set) => (
              <PhotoSetCard
                key={set.id}
                set={set}
                onRetry={() => retry.mutate(set.id)}
                retrying={retry.isPending && retry.variables === set.id}
                onDelete={() => {
                  const working = WORKING.includes(set.status);
                  if (window.confirm(working ? "Stop making these photos?" : "Delete these photos?")) {
                    remove.mutate(set.id);
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

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-lg border px-3 py-1.5 text-sm transition-colors",
        active
          ? "border-primary bg-primary/15 text-primary"
          : "border-border text-muted hover:border-border-strong hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function PhotoSetCard({
  set,
  onRetry,
  retrying,
  onDelete,
}: {
  set: PhotoSetSummary;
  onRetry: () => void;
  retrying: boolean;
  onDelete: () => void;
}) {
  const working = WORKING.includes(set.status);
  const modeLabel = PHOTO_MODES.find((m) => m.value === set.mode)?.label;
  const first = set.photos?.[0];
  const meta = [
    set.channel,
    set.duration ? formatDuration(set.duration) : null,
    `${set.photos?.length ?? set.count} photos · ${modeLabel}`,
    formatRelativeTime(set.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="p-4">
      <div className="flex gap-4">
        <img
          src={set.thumbnailUrl}
          alt=""
          className="h-16 w-28 shrink-0 rounded-md bg-surface-raised object-cover"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{set.title ?? set.url}</p>
              <p className="mt-0.5 truncate text-xs text-muted">{meta}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {set.status === "READY" && set.zipUrl && (
                <a href={set.zipUrl} download={set.zipFileName}>
                  <Button size="sm">
                    <Download className="h-4 w-4" />
                    Download all
                    {set.zipBytes ? ` (${formatBytes(set.zipBytes)})` : ""}
                  </Button>
                </a>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={onDelete}
                aria-label={working ? "Stop" : "Delete"}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {working && (
            <div className="mt-3">
              <ProgressBar value={set.progress} label={set.step ?? "Waiting to start…"} />
            </div>
          )}

          {set.status === "FAILED" && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-1 text-xs text-danger">
                {set.error ?? "These photos couldn't be made."}
              </p>
              <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
                <RefreshCcw className="h-4 w-4" />
                Try again
              </Button>
            </div>
          )}

          {first && (
            <p className="mt-1 text-xs text-muted">
              {first.width && first.height ? `${first.width}×${first.height} JPEG` : "JPEG"} ·
              click a photo to open it full size
            </p>
          )}
        </div>
      </div>

      {set.photos && set.photos.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {set.photos.map((photo) => (
            <div
              key={photo.index}
              className="group relative overflow-hidden rounded-md bg-surface-raised"
            >
              <a href={photo.viewUrl} target="_blank" rel="noreferrer">
                <img
                  src={photo.viewUrl}
                  alt={`Photo at ${clock(photo.time)}`}
                  loading="lazy"
                  className="aspect-video w-full object-cover transition-transform group-hover:scale-[1.02]"
                />
              </a>
              <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[11px] text-white">
                {clock(photo.time)}
              </span>
              <a
                href={photo.downloadUrl}
                download={photo.fileName}
                aria-label="Download this photo"
                className="absolute right-1.5 top-1.5 rounded-md bg-black/65 p-1.5 text-white opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
              >
                <Download className="h-3.5 w-3.5" />
              </a>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
