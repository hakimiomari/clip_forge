"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Loader2,
  Pencil,
  RefreshCcw,
  Trash2,
  AlertTriangle,
  Wand2,
} from "lucide-react";
import { EffectsEditor, type EffectItem } from "./effects-editor";
import { api, ApiError } from "@/lib/api";
import type { ClipDetailResponse } from "@/lib/types";
import type { DownloadLink } from "@clipforge/shared-types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress";
import { Input, Label, FieldError } from "@/components/ui/input";
import { formatDuration } from "@/lib/utils";

const ACTIVE = ["RENDER_QUEUED", "RENDERING"];

export function ClipCard({
  clipId,
  projectId,
}: {
  clipId: string;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showEffects, setShowEffects] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: clip } = useQuery({
    queryKey: ["clip", clipId],
    queryFn: () => api<ClipDetailResponse>(`/clips/${clipId}`),
    refetchInterval: (q) =>
      q.state.data && ACTIVE.includes(q.state.data.status) ? 2500 : false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["clip", clipId] });
    void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
  };

  const rerender = useMutation({
    mutationFn: () => api(`/clips/${clipId}/render`, { method: "POST" }),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  const remove = useMutation({
    mutationFn: () => api(`/clips/${clipId}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  const handleDownload = async () => {
    setError(null);
    try {
      const link = await api<DownloadLink>(`/clips/${clipId}/download`);
      const a = document.createElement("a");
      a.href = link.downloadUrl;
      a.download = link.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  if (!clip) {
    return (
      <Card className="flex items-center justify-center p-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      </Card>
    );
  }

  const isActive = ACTIVE.includes(clip.status);

  return (
    <Card className="p-4">
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="w-full shrink-0 sm:w-44">
          <div className="aspect-[9/16] w-full overflow-hidden rounded-lg bg-black">
            {clip.previewUrl ? (
              <video
                src={clip.previewUrl}
                controls
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted">
                {isActive ? "Rendering…" : "No preview yet"}
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h4 className="truncate font-semibold">{clip.name ?? "Clip"}</h4>
            <StatusBadge status={clip.status} />
          </div>
          <p className="text-xs text-muted">
            {clip.format ?? "vertical"} · {clip.resolution ?? "1080x1920"} ·{" "}
            {clip.duration != null ? `${Math.round(clip.duration)}s` : "—"}
          </p>

          {isActive && (
            <ProgressBar
              className="mt-3"
              value={clip.renderJob?.progress ?? 5}
              label={clip.renderJob?.step ?? "Waiting in queue"}
            />
          )}

          {clip.status === "FAILED" && clip.renderJob?.error && (
            <p className="mt-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {clip.renderJob.error}
            </p>
          )}

          <FieldError message={error ?? undefined} />

          <div className="mt-3 flex flex-wrap gap-2">
            {clip.status === "RENDERED" && (
              <Button size="sm" onClick={handleDownload}>
                <Download className="h-4 w-4" />
                Download MP4
              </Button>
            )}
            {!isActive && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEditing((v) => !v);
                    setShowEffects(false);
                  }}
                >
                  <Pencil className="h-4 w-4" />
                  {editing ? "Close editor" : "Edit"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setShowEffects((v) => !v);
                    setEditing(false);
                  }}
                >
                  <Wand2 className="h-4 w-4" />
                  {showEffects ? "Close effects" : "Effects"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={rerender.isPending}
                  onClick={() => rerender.mutate()}
                >
                  <RefreshCcw className="h-4 w-4" />
                  Re-render
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  loading={remove.isPending}
                  onClick={() => {
                    if (window.confirm("Delete this clip and its exports?")) {
                      remove.mutate();
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>

          {editing && !isActive && (
            <ClipEditor
              clip={clip}
              onSaved={() => {
                setEditing(false);
                invalidate();
              }}
            />
          )}

          {showEffects && !isActive && (
            <EffectsEditor
              clipId={clip.id}
              clipDuration={
                clip.editingPlan?.segments?.[0]
                  ? clip.editingPlan.segments[0].sourceEnd -
                    clip.editingPlan.segments[0].sourceStart
                  : (clip.duration ?? 60)
              }
              previewUrl={clip.previewUrl}
              initialEffects={
                (clip.editingPlan?.rangeEffects ?? []) as unknown as EffectItem[]
              }
              onSaved={(rendered) => {
                if (rendered) setShowEffects(false);
                invalidate();
              }}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

function ClipEditor({
  clip,
  onSaved,
}: {
  clip: ClipDetailResponse;
  onSaved: () => void;
}) {
  const [name, setName] = useState(clip.name ?? "");
  const [format, setFormat] = useState(clip.format ?? "vertical");
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [captionStyle, setCaptionStyle] = useState("bold_dynamic");
  const [zoomEnabled, setZoomEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (opts: { renderAfter: boolean }) => {
      await api(`/clips/${clip.id}`, {
        method: "PATCH",
        body: { name: name || undefined, format, captionsEnabled, captionStyle, zoomEnabled },
      });
      if (opts.renderAfter) {
        await api(`/clips/${clip.id}/render`, { method: "POST" });
      }
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-border bg-surface-raised p-4">
      <div>
        <Label htmlFor={`clip-name-${clip.id}`}>Clip name</Label>
        <Input
          id={`clip-name-${clip.id}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Format</Label>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm"
          >
            <option value="vertical">Vertical 9:16</option>
            <option value="square">Square 1:1</option>
            <option value="landscape">Landscape 16:9</option>
          </select>
        </div>
        <div>
          <Label>Caption style</Label>
          <select
            value={captionStyle}
            onChange={(e) => setCaptionStyle(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm"
          >
            <option value="bold_dynamic">Bold dynamic</option>
            <option value="minimal">Minimal</option>
            <option value="professional">Professional</option>
            <option value="podcast">Podcast</option>
            <option value="news">News</option>
          </select>
        </div>
      </div>
      <div className="flex gap-5 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={captionsEnabled}
            onChange={(e) => setCaptionsEnabled(e.target.checked)}
            className="h-4 w-4 accent-[#6d5cff]"
          />
          Captions
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={zoomEnabled}
            onChange={(e) => setZoomEnabled(e.target.checked)}
            className="h-4 w-4 accent-[#6d5cff]"
          />
          Slow zoom
        </label>
      </div>
      <FieldError message={error ?? undefined} />
      <div className="flex gap-2">
        <Button
          size="sm"
          loading={save.isPending}
          onClick={() => save.mutate({ renderAfter: true })}
        >
          Save & re-render
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={save.isPending}
          onClick={() => save.mutate({ renderAfter: false })}
        >
          Save only
        </Button>
      </div>
      <p className="text-xs text-muted">
        Re-rendering costs credits based on clip length ({formatDuration(clip.duration)}).
      </p>
    </div>
  );
}
