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
  const [captionsEnabled, setCaptionsEnabled] = useState(
    clip.editingPlan?.captions?.enabled ?? true,
  );
  const [captionStyle, setCaptionStyle] = useState(
    clip.editingPlan?.captions?.style ?? "bold_dynamic",
  );
  const [zoomEnabled, setZoomEnabled] = useState(true);
  const [backgroundMode, setBackgroundMode] = useState(
    clip.editingPlan?.background?.type === "crop_fill"
      ? "fill"
      : clip.editingPlan?.background?.type === "blurred_original"
        ? "blur"
        : clip.editingPlan?.background
          ? "blur"
          : "black",
  );
  const planAudio = clip.editingPlan?.audio;
  const [volume, setVolume] = useState(planAudio?.originalVolume ?? 1);
  const [pitch, setPitch] = useState(planAudio?.pitchSemitones ?? 0);
  const [bassGain, setBassGain] = useState(planAudio?.bassGain ?? 0);
  const [trebleGain, setTrebleGain] = useState(planAudio?.trebleGain ?? 0);
  const [noiseReduction, setNoiseReduction] = useState(planAudio?.noiseReduction ?? false);
  const [voiceEnhance, setVoiceEnhance] = useState(planAudio?.voiceEnhance ?? false);
  const [voiceEffect, setVoiceEffect] = useState(planAudio?.voiceEffect ?? "none");
  const [normalize, setNormalize] = useState(planAudio?.normalize ?? true);
  const planBg = clip.editingPlan?.backgroundRemoval;
  const [bgRemovalEnabled, setBgRemovalEnabled] = useState(planBg?.enabled ?? false);
  const [bgReplace, setBgReplace] = useState(planBg?.replace ?? "blur");
  const [bgColor, setBgColor] = useState(planBg?.color ?? "0b0d12");
  const planCta = clip.editingPlan?.cta;
  const [ctaEnabled, setCtaEnabled] = useState(planCta?.enabled ?? true);
  const [ctaLike, setCtaLike] = useState(planCta?.likeText ?? "LIKE");
  const [ctaFollow, setCtaFollow] = useState(planCta?.followText ?? "FOLLOW");
  const [ctaTiming, setCtaTiming] = useState(planCta?.timing ?? "middle");
  const [ctaStart, setCtaStart] = useState(String(planCta?.customStart ?? 0));
  const [ctaEnd, setCtaEnd] = useState(
    String(planCta?.customEnd ?? Math.round(clip.duration ?? 30)),
  );
  const [ctaPosition, setCtaPosition] = useState(planCta?.position ?? "top");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (opts: { renderAfter: boolean }) => {
      await api(`/clips/${clip.id}`, {
        method: "PATCH",
        body: {
          name: name || undefined,
          format,
          captionsEnabled,
          captionStyle,
          zoomEnabled,
          backgroundMode,
          audio: {
            volume,
            pitchSemitones: pitch,
            bassGain,
            trebleGain,
            noiseReduction,
            voiceEnhance,
            voiceEffect,
            normalize,
          },
          backgroundRemoval: {
            enabled: bgRemovalEnabled,
            replace: bgReplace,
            ...(bgReplace === "color" ? { color: bgColor } : {}),
          },
          cta: {
            enabled: ctaEnabled,
            likeText: ctaLike,
            followText: ctaFollow,
            timing: ctaTiming,
            position: ctaPosition,
            ...(ctaTiming === "custom"
              ? { customStart: Number(ctaStart) || 0, customEnd: Number(ctaEnd) || 5 }
              : {}),
          },
        },
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
        <div className="col-span-2">
          <Label>Background</Label>
          <select
            value={backgroundMode}
            onChange={(e) => setBackgroundMode(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm"
          >
            <option value="blur">Blurred bars (fit whole video)</option>
            <option value="fill">Fill screen (crop the sides, no bars)</option>
            <option value="black">Black bars</option>
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

      <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
        <p className="text-sm font-semibold">🎙️ Voice & audio</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <div>
            <Label>
              Volume: {Math.round(volume * 100)}%
              {volume === 2 ? " (double)" : volume === 0 ? " (muted)" : ""}
            </Label>
            <input
              type="range"
              min={0}
              max={3}
              step={0.1}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-full accent-[#6d5cff]"
            />
          </div>
          <div>
            <Label>
              Voice pitch:{" "}
              {pitch === 0
                ? "normal"
                : pitch > 0
                  ? `+${pitch} (higher)`
                  : `${pitch} (deeper)`}
            </Label>
            <input
              type="range"
              min={-12}
              max={12}
              step={1}
              value={pitch}
              onChange={(e) => setPitch(Number(e.target.value))}
              className="w-full accent-[#6d5cff]"
            />
          </div>
          <div>
            <Label>Bass: {bassGain > 0 ? `+${bassGain}` : bassGain} dB</Label>
            <input
              type="range"
              min={-10}
              max={10}
              step={1}
              value={bassGain}
              onChange={(e) => setBassGain(Number(e.target.value))}
              className="w-full accent-[#6d5cff]"
            />
          </div>
          <div>
            <Label>Treble: {trebleGain > 0 ? `+${trebleGain}` : trebleGain} dB</Label>
            <input
              type="range"
              min={-10}
              max={10}
              step={1}
              value={trebleGain}
              onChange={(e) => setTrebleGain(Number(e.target.value))}
              className="w-full accent-[#6d5cff]"
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={noiseReduction}
              onChange={(e) => setNoiseReduction(e.target.checked)}
              className="h-4 w-4 accent-[#6d5cff]"
            />
            Noise reduction
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={voiceEnhance}
              onChange={(e) => setVoiceEnhance(e.target.checked)}
              className="h-4 w-4 accent-[#6d5cff]"
            />
            Voice clarity
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={normalize}
              onChange={(e) => setNormalize(e.target.checked)}
              className="h-4 w-4 accent-[#6d5cff]"
            />
            Normalize loudness
          </label>
        </div>
        <div>
          <Label>Voice effect</Label>
          <select
            value={voiceEffect}
            onChange={(e) => setVoiceEffect(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-surface-raised px-2 text-sm"
          >
            <option value="none">None</option>
            <option value="telephone">Telephone / radio</option>
            <option value="echo">Echo / stadium</option>
            <option value="robot">Robot</option>
          </select>
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={bgRemovalEnabled}
            onChange={(e) => setBgRemovalEnabled(e.target.checked)}
            className="h-4 w-4 accent-[#6d5cff]"
          />
          ✂️ Remove background (AI)
        </label>
        {bgRemovalEnabled && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Replace with</Label>
                <select
                  value={bgReplace}
                  onChange={(e) => setBgReplace(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-surface-raised px-2 text-sm"
                >
                  <option value="blur">Blurred original (portrait look)</option>
                  <option value="color">Solid color</option>
                </select>
              </div>
              {bgReplace === "color" && (
                <div>
                  <Label>Color (hex)</Label>
                  <Input
                    value={bgColor}
                    onChange={(e) => setBgColor(e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6))}
                    placeholder="0b0d12"
                    className="h-9"
                  />
                </div>
              )}
            </div>
            <p className="text-xs text-warning">
              Runs a local AI segmentation model on every frame — adds a few
              minutes to the render. Works best with a single clear subject
              (talking-head style); not compatible with speed effects.
            </p>
          </>
        )}
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={ctaEnabled}
            onChange={(e) => setCtaEnabled(e.target.checked)}
            className="h-4 w-4 accent-[#6d5cff]"
          />
          ♥ Like &amp; Follow banner
        </label>
        {ctaEnabled && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Like text</Label>
                <Input
                  value={ctaLike}
                  onChange={(e) => setCtaLike(e.target.value)}
                  maxLength={20}
                  className="h-9"
                />
              </div>
              <div>
                <Label>Follow text</Label>
                <Input
                  value={ctaFollow}
                  onChange={(e) => setCtaFollow(e.target.value)}
                  maxLength={20}
                  placeholder="FOLLOW or SUBSCRIBE"
                  className="h-9"
                />
              </div>
              <div>
                <Label>When</Label>
                <select
                  value={ctaTiming}
                  onChange={(e) => setCtaTiming(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-surface-raised px-2 text-sm"
                >
                  <option value="start">Start (first ~5s)</option>
                  <option value="middle">Middle (~4s)</option>
                  <option value="end">End (last ~5s)</option>
                  <option value="always">Whole clip</option>
                  <option value="custom">Custom window…</option>
                </select>
              </div>
              <div>
                <Label>Where</Label>
                <select
                  value={ctaPosition}
                  onChange={(e) => setCtaPosition(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-surface-raised px-2 text-sm"
                >
                  <option value="top">Top</option>
                  <option value="bottom">Bottom (above captions)</option>
                </select>
              </div>
            </div>
            {ctaTiming === "custom" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Show from (s)</Label>
                  <Input
                    value={ctaStart}
                    onChange={(e) => setCtaStart(e.target.value)}
                    className="h-9"
                  />
                </div>
                <div>
                  <Label>Until (s)</Label>
                  <Input
                    value={ctaEnd}
                    onChange={(e) => setCtaEnd(e.target.value)}
                    className="h-9"
                  />
                </div>
              </div>
            )}
          </>
        )}
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
