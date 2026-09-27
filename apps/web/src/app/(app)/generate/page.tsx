"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Trash2, Wand2 } from "lucide-react";
import {
  GENERATED_LENGTHS,
  GENERATED_STYLES,
  GENERATED_VIDEO_CREDITS,
  type GeneratedEngine,
  type GeneratedVideoSummary,
} from "@clipforge/shared-types";
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

interface EngineInfo {
  engine: GeneratedEngine;
  label: string;
  note: string;
  shotSeconds: number;
  realVideo: boolean;
}

export default function GeneratePage() {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState("vertical");
  const [targetSeconds, setTargetSeconds] = useState<number>(8);
  const [style, setStyle] = useState("cinematic");
  const [error, setError] = useState<string | null>(null);

  const { data: engine } = useQuery({
    queryKey: ["generated-engine"],
    queryFn: () => api<EngineInfo>("/generated/engine"),
    staleTime: 60_000,
  });

  const { data: items, isLoading } = useQuery({
    queryKey: ["generated"],
    queryFn: () => api<GeneratedVideoSummary[]>("/generated"),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((v) => BUSY_STATUSES.includes(v.status))
        ? 2500
        : false,
  });

  const create = useMutation({
    mutationFn: () =>
      api<GeneratedVideoSummary>("/generated", {
        method: "POST",
        body: { prompt: prompt.trim(), format, targetSeconds, style },
      }),
    onSuccess: () => {
      setError(null);
      setPrompt("");
      void queryClient.invalidateQueries({ queryKey: ["generated"] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/generated/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["generated"] }),
  });

  const busy = (items ?? []).some((v) => BUSY_STATUSES.includes(v.status));
  const shots = engine ? Math.max(1, Math.min(6, Math.ceil(targetSeconds / engine.shotSeconds))) : null;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Wand2 className="h-6 w-6 text-primary" />
          AI video
        </h1>
        <p className="mt-1 text-sm text-muted">
          Describe a scene and ClipForge generates it as a short video, shot by
          shot, then joins the shots into one.
        </p>
      </div>

      <Card>
        <Label htmlFor="generate-prompt">What should the video show?</Label>
        <Input
          id="generate-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="A person in a sleek VR headset inside a glowing holographic interface, neon blue and purple"
          onKeyDown={(e) => {
            if (e.key === "Enter" && prompt.trim().length >= 3 && !busy) {
              create.mutate();
            }
          }}
        />

        <div className="mt-4">
          <Label>Length</Label>
          <div className="flex flex-wrap gap-2">
            {GENERATED_LENGTHS.map((seconds) => (
              <Chip
                key={seconds}
                active={targetSeconds === seconds}
                onClick={() => setTargetSeconds(seconds)}
              >
                {seconds}s
              </Chip>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <Label>Look</Label>
          <div className="flex flex-wrap gap-2">
            {GENERATED_STYLES.map((s) => (
              <Chip key={s.value} active={style === s.value} onClick={() => setStyle(s.value)}>
                {s.label}
              </Chip>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <Label>Format</Label>
          <div className="flex flex-wrap gap-2">
            {FORMATS.map((f) => (
              <Chip key={f.value} active={format === f.value} onClick={() => setFormat(f.value)}>
                {f.label}
              </Chip>
            ))}
          </div>
        </div>

        {engine && (
          <div
            className={cn(
              "mt-4 rounded-lg border px-3 py-2 text-xs",
              engine.realVideo
                ? "border-primary/30 bg-primary/5 text-muted-strong"
                : "border-warning/30 bg-warning/5 text-warning",
            )}
          >
            <span className="font-medium">Engine: {engine.label}.</span> {engine.note}
            {shots !== null && (
              <>
                {" "}
                This video will be {shots} shot{shots === 1 ? "" : "s"} of{" "}
                {engine.shotSeconds}s.
              </>
            )}
          </div>
        )}

        <Button
          className="mt-5 w-full"
          onClick={() => create.mutate()}
          loading={create.isPending}
          disabled={prompt.trim().length < 3 || busy}
        >
          <Wand2 className="h-4 w-4" />
          {busy ? "A video is already generating…" : "Generate the video"}
        </Button>
        <p className="mt-2 text-center text-xs text-muted">
          {GENERATED_VIDEO_CREDITS} credits.{" "}
          {engine?.realVideo
            ? "Each shot takes a minute or two to generate."
            : "Takes about a minute."}
        </p>
        <FieldError message={error ?? undefined} />
      </Card>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Your AI videos</h2>
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        ) : (items ?? []).length === 0 ? (
          <Card>
            <CardDescription>
              Nothing yet — describe a scene above to generate the first one.
            </CardDescription>
          </Card>
        ) : (
          <div className="space-y-4">
            {(items ?? []).map((item) => (
              <GeneratedCard
                key={item.id}
                item={item}
                onDelete={() => {
                  if (window.confirm("Delete this video?")) {
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

function GeneratedCard({
  item,
  onDelete,
}: {
  item: GeneratedVideoSummary;
  onDelete: () => void;
}) {
  const busy = BUSY_STATUSES.includes(item.status);
  const styleLabel = GENERATED_STYLES.find((s) => s.value === item.style)?.label ?? item.style;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle className="truncate">{item.title ?? item.prompt}</CardTitle>
          <p className="mt-0.5 text-xs text-muted">
            {item.format} · {styleLabel}
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
              download={`${item.prompt.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.mp4`}
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
