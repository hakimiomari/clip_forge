"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, RefreshCcw, Search, Sparkles, Trash2 } from "lucide-react";
import type { ResearchVideoSummary } from "@clipforge/shared-types";
import { api, ApiError } from "@/lib/api";
import { cn, formatDuration, formatRelativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Input, Label, FieldError } from "@/components/ui/input";
import { ProgressBar } from "@/components/ui/progress";

const BUSY_STATUSES = ["PENDING", "RESEARCHING", "BUILDING", "RENDERING"];

const FORMATS = [
  { value: "vertical", label: "Vertical 9:16" },
  { value: "square", label: "Square 1:1" },
  { value: "landscape", label: "Landscape 16:9" },
] as const;

const CARTOON_STYLES = [
  { value: "none", label: "Photos", hint: "The pictures as they are" },
  { value: "hayao", label: "Hayao", hint: "Ghibli-like: soft, painterly" },
  { value: "shinkai", label: "Shinkai", hint: "High contrast, vivid skies" },
] as const;

export default function ResearchPage() {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState("vertical");
  const [cartoonStyle, setCartoonStyle] = useState("none");
  const [error, setError] = useState<string | null>(null);

  const { data: videos, isLoading } = useQuery({
    queryKey: ["research"],
    queryFn: () => api<ResearchVideoSummary[]>("/research"),
    // Poll while anything is building; the worker writes progress to the row
    refetchInterval: (query) =>
      (query.state.data ?? []).some((v) => BUSY_STATUSES.includes(v.status))
        ? 2500
        : false,
  });

  const create = useMutation({
    mutationFn: () =>
      api<ResearchVideoSummary>("/research", {
        method: "POST",
        body: { prompt: prompt.trim(), format, cartoonStyle },
      }),
    onSuccess: () => {
      setError(null);
      setPrompt("");
      void queryClient.invalidateQueries({ queryKey: ["research"] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/research/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["research"] }),
  });

  const retry = useMutation({
    mutationFn: (id: string) => api(`/research/${id}/retry`, { method: "POST" }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["research"] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });

  const busy = (videos ?? []).some((v) => BUSY_STATUSES.includes(v.status));

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Sparkles className="h-6 w-6 text-accent" />
          Research video
        </h1>
        <p className="mt-1 text-sm text-muted">
          Name a topic. ClipForge reads it up, gathers openly-licensed pictures
          and clips, and builds a narrated video from what it finds.
        </p>
      </div>

      <Card>
        <Label htmlFor="research-prompt">What should the video be about?</Label>
        <Input
          id="research-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="The history of the Cricket World Cup"
          onKeyDown={(e) => {
            if (e.key === "Enter" && prompt.trim() && !busy) create.mutate();
          }}
        />

        <div className="mt-4">
          <Label>Format</Label>
          <div className="flex flex-wrap gap-2">
            {FORMATS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={format === f.value}
                onClick={() => setFormat(f.value)}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                  format === f.value
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-border text-muted hover:border-border-strong hover:text-foreground",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <Label>Look</Label>
          <div className="flex flex-wrap gap-2">
            {CARTOON_STYLES.map((s) => (
              <button
                key={s.value}
                type="button"
                title={s.hint}
                aria-pressed={cartoonStyle === s.value}
                onClick={() => setCartoonStyle(s.value)}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                  cartoonStyle === s.value
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-border text-muted hover:border-border-strong hover:text-foreground",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {cartoonStyle === "none"
              ? "Scenes use the original photographs."
              : "Each picture is redrawn by a local AnimeGANv3 model — adds a few minutes to the build."}
          </p>
        </div>

        <Button
          className="mt-5 w-full"
          onClick={() => create.mutate()}
          loading={create.isPending}
          disabled={prompt.trim().length < 3 || busy}
        >
          <Search className="h-4 w-4" />
          {busy ? "A video is already building…" : "Research and build the video"}
        </Button>
        <p className="mt-2 text-center text-xs text-muted">
          4 credits. Facts come from Wikipedia, pictures and clips from
          Wikimedia Commons — every source is credited in the description.
        </p>
        <FieldError message={error ?? undefined} />
      </Card>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Your research videos</h2>
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        ) : (videos ?? []).length === 0 ? (
          <Card>
            <CardDescription>
              Nothing yet — describe a topic above and the first one will appear
              here.
            </CardDescription>
          </Card>
        ) : (
          <div className="space-y-4">
            {(videos ?? []).map((video) => (
              <ResearchCard
                key={video.id}
                video={video}
                onRetry={() => retry.mutate(video.id)}
                retrying={retry.isPending && retry.variables === video.id}
                onDelete={() => {
                  if (window.confirm("Delete this video?")) remove.mutate(video.id);
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ResearchCard({
  video,
  onDelete,
  onRetry,
  retrying,
}: {
  video: ResearchVideoSummary;
  onDelete: () => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  const busy = BUSY_STATUSES.includes(video.status);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle className="truncate">{video.title ?? video.prompt}</CardTitle>
          <p className="mt-0.5 text-xs text-muted">
            “{video.prompt}” · {video.format}
            {video.cartoonStyle && video.cartoonStyle !== "none"
              ? ` · ${video.cartoonStyle} cartoon`
              : ""}
            {video.duration ? ` · ${formatDuration(video.duration)}` : ""} ·{" "}
            {formatRelativeTime(video.createdAt)}
          </p>
        </div>
        <Button size="sm" variant="danger" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {busy && (
        <div className="mt-4">
          <ProgressBar value={video.progress} label={video.step ?? "Working…"} />
        </div>
      )}

      {video.status === "FAILED" && (
        <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
          <p className="text-xs text-danger">{video.error ?? "This build failed."}</p>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={onRetry}
            loading={retrying}
          >
            <RefreshCcw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      )}

      {video.status === "READY" && video.videoUrl && (
        <div className="mt-4 grid gap-4 md:grid-cols-5">
          <video
            src={video.videoUrl}
            controls
            className="w-full rounded-lg bg-black md:col-span-2"
          />
          <div className="md:col-span-3">
            {video.description && (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-raised px-3 py-2 font-sans text-xs text-muted-strong">
                {video.description}
              </pre>
            )}
            <a
              href={video.videoUrl}
              download={`${(video.title ?? "research").replace(/[^a-z0-9]+/gi, "-")}.mp4`}
              className="mt-3 inline-flex"
            >
              <Button size="sm">
                <Download className="h-4 w-4" />
                Download MP4
              </Button>
            </a>
          </div>
        </div>
      )}
    </Card>
  );
}
