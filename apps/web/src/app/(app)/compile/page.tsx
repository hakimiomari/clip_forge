"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, Download, Loader2, Trash2 } from "lucide-react";
import type { CompilationSummary } from "@clipforge/shared-types";
import { api, ApiError } from "@/lib/api";
import { cn, formatDuration, formatRelativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Input, Label, FieldError } from "@/components/ui/input";
import { ProgressBar } from "@/components/ui/progress";

const BUSY_STATUSES = ["PENDING", "RESEARCHING", "BUILDING", "RENDERING"];

const LENGTHS = [60, 90, 120] as const;
const FRESHNESS = [
  { value: "all_time", label: "Best of all time", hint: "YouTube's most-watched classics" },
  { value: "mix", label: "Mix", hint: "Classics plus this year's uploads" },
  { value: "latest", label: "Latest", hint: "Uploads from the last month" },
] as const;
const FORMATS = [
  { value: "vertical", label: "Vertical 9:16" },
  { value: "square", label: "Square 1:1" },
  { value: "landscape", label: "Landscape 16:9" },
] as const;

export default function CompilePage() {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState("vertical");
  const [targetSeconds, setTargetSeconds] = useState<number>(60);
  const [freshness, setFreshness] = useState("mix");
  const [error, setError] = useState<string | null>(null);

  const { data: items, isLoading } = useQuery({
    queryKey: ["compilations"],
    queryFn: () => api<CompilationSummary[]>("/compilations"),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((v) => BUSY_STATUSES.includes(v.status))
        ? 2500
        : false,
  });

  const create = useMutation({
    mutationFn: () =>
      api<CompilationSummary>("/compilations", {
        method: "POST",
        body: { prompt: prompt.trim(), format, targetSeconds, freshness },
      }),
    onSuccess: () => {
      setError(null);
      setPrompt("");
      void queryClient.invalidateQueries({ queryKey: ["compilations"] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/compilations/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["compilations"] }),
  });

  const busy = (items ?? []).some((v) => BUSY_STATUSES.includes(v.status));

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Clapperboard className="h-6 w-6 text-primary" />
          Best-of compilation
        </h1>
        <p className="mt-1 text-sm text-muted">
          Describe the video you want. ClipForge searches YouTube, finds the
          strongest moments across several videos, and joins them into one.
        </p>
      </div>

      <Card>
        <Label htmlFor="compile-prompt">What should the compilation show?</Label>
        <Input
          id="compile-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="best run outs in cricket"
          onKeyDown={(e) => {
            if (e.key === "Enter" && prompt.trim().length >= 3 && !busy) {
              create.mutate();
            }
          }}
        />

        <div className="mt-4">
          <Label>Length</Label>
          <div className="flex flex-wrap gap-2">
            {LENGTHS.map((seconds) => (
              <Chip
                key={seconds}
                active={targetSeconds === seconds}
                onClick={() => setTargetSeconds(seconds)}
              >
                {seconds < 120 ? `${seconds}s` : "2 min"}
              </Chip>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <Label>Which videos</Label>
          <div className="flex flex-wrap gap-2">
            {FRESHNESS.map((f) => (
              <Chip
                key={f.value}
                active={freshness === f.value}
                onClick={() => setFreshness(f.value)}
              >
                {f.label}
              </Chip>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {FRESHNESS.find((f) => f.value === freshness)?.hint}. Full matches up to
            8 hours are included.
          </p>
        </div>

        <div className="mt-4">
          <Label>Format</Label>
          <div className="flex flex-wrap gap-2">
            {FORMATS.map((f) => (
              <Chip
                key={f.value}
                active={format === f.value}
                onClick={() => setFormat(f.value)}
              >
                {f.label}
              </Chip>
            ))}
          </div>
        </div>

        <Button
          className="mt-5 w-full"
          onClick={() => create.mutate()}
          loading={create.isPending}
          disabled={prompt.trim().length < 3 || busy}
        >
          <Clapperboard className="h-4 w-4" />
          {busy ? "A compilation is already building…" : "Find clips and build it"}
        </Button>
        <p className="mt-2 text-center text-xs text-muted">
          6 credits. Takes several minutes — it analyses each video it finds
          before downloading only the moments it keeps.
        </p>
        <p className="mt-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
          Clips come from YouTube and stay the property of their owners. Every
          video used is named on screen and listed in the description. Check you
          have the right to republish before posting a compilation.
        </p>
        <FieldError message={error ?? undefined} />
      </Card>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Your compilations</h2>
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        ) : (items ?? []).length === 0 ? (
          <Card>
            <CardDescription>
              Nothing yet — describe a compilation above to make the first one.
            </CardDescription>
          </Card>
        ) : (
          <div className="space-y-4">
            {(items ?? []).map((item) => (
              <CompilationCard
                key={item.id}
                item={item}
                onDelete={() => {
                  if (window.confirm("Delete this compilation?")) {
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

function CompilationCard({
  item,
  onDelete,
}: {
  item: CompilationSummary;
  onDelete: () => void;
}) {
  const busy = BUSY_STATUSES.includes(item.status);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle className="truncate">{item.title ?? item.prompt}</CardTitle>
          <p className="mt-0.5 text-xs text-muted">
            {item.format}
            {item.duration ? ` · ${formatDuration(item.duration)}` : ""} ·{" "}
            {formatRelativeTime(item.createdAt)}
          </p>
        </div>
        <Button size="sm" variant="danger" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {busy && (
        <div className="mt-4">
          <ProgressBar value={item.progress} label={item.step ?? "Working…"} />
        </div>
      )}

      {item.status === "FAILED" && (
        <p className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {item.error ?? "This build failed."}
        </p>
      )}

      {item.status === "READY" && item.videoUrl && (
        <div className="mt-4 grid gap-4 md:grid-cols-5">
          <video
            src={item.videoUrl}
            controls
            className="w-full rounded-lg bg-black md:col-span-2"
          />
          <div className="md:col-span-3">
            {item.description && (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-raised px-3 py-2 font-sans text-xs text-muted-strong">
                {item.description}
              </pre>
            )}
            <a
              href={item.videoUrl}
              download={`${item.prompt.replace(/[^a-z0-9]+/gi, "-")}.mp4`}
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
