"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Download,
  FileText,
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

  const saveFile = (href: string, fileName: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  /**
   * Saves the MP4 and, next to it, a text file holding the title and
   * description — so the caption travels with the video instead of
   * having to be copied out of the app separately.
   */
  const handleDownload = async () => {
    setError(null);
    try {
      const link = await api<DownloadLink>(`/clips/${clipId}/download`);
      saveFile(link.downloadUrl, link.fileName);

      if (link.title || link.description) {
        const caption = `${link.title}\n\n${link.description}\n`;
        const blob = new Blob([caption], { type: "text/plain;charset=utf-8" });
        const blobUrl = URL.createObjectURL(blob);
        saveFile(blobUrl, link.fileName.replace(/\.mp4$/i, "") + ".txt");
        // Let the download start before the object URL is torn down
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
      }
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

          {clip.description && <PostDetails clip={clip} />}

          <div className="mt-3 flex flex-wrap gap-2">
            {clip.status === "RENDERED" && (
              <Button
                size="sm"
                onClick={handleDownload}
                title="Saves the video and a .txt with its title and description"
              >
                <Download className="h-4 w-4" />
                Download MP4 + caption
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

/**
 * Title and caption to paste where the short is posted. Built from the
 * clip's own transcript and source video, so it states only what is
 * actually in the clip.
 */
function PostDetails({ clip }: { clip: ClipDetailResponse }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"title" | "description" | null>(null);

  const copy = async (what: "title" | "description", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard needs a secure context; the text is on screen to select
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:text-foreground"
        aria-expanded={open}
      >
        <FileText className="h-4 w-4 text-muted" />
        Title &amp; description for posting
        <span className="ml-auto text-xs text-muted">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label className="mb-0">Title</Label>
              <Button size="sm" variant="ghost" onClick={() => copy("title", clip.name ?? "")}>
                <Copy className="h-3.5 w-3.5" />
                {copied === "title" ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm">
              {clip.name}
            </p>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label className="mb-0">Description</Label>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copy("description", clip.description ?? "")}
              >
                <Copy className="h-3.5 w-3.5" />
                {copied === "description" ? "Copied" : "Copy"}
              </Button>
            </div>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-raised px-3 py-2 font-sans text-sm text-muted-strong">
              {clip.description}
            </pre>
          </div>
          <p className="text-xs text-muted">
            Taken from what is said in the clip and the source video — edit it
            in the clip editor if you want different wording.
          </p>
        </div>
      )}
    </div>
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
  const [description, setDescription] = useState(clip.description ?? "");
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
  const planCartoon = clip.editingPlan?.cartoon;
  const [cartoonEnabled, setCartoonEnabled] = useState(planCartoon?.enabled ?? false);
  const [cartoonStyle, setCartoonStyle] = useState(planCartoon?.style ?? "hayao");
  const [cartoonFps, setCartoonFps] = useState(String(planCartoon?.fps ?? 12));
  const [cartoonQuality, setCartoonQuality] = useState(planCartoon?.quality ?? "high");
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
          description,
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
          cartoon: {
            enabled: cartoonEnabled,
            style: cartoonStyle,
            fps: Number(cartoonFps) || 12,
            quality: cartoonQuality,
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
        <Label htmlFor={`clip-name-${clip.id}`}>Title</Label>
        <Input
          id={`clip-name-${clip.id}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor={`clip-desc-${clip.id}`}>Description (for posting)</Label>
        <textarea
          id={`clip-desc-${clip.id}`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          placeholder="What happens in this clip, where it came from, hashtags…"
        />
        <p className="mt-1 text-xs text-muted">
          Written from the clip&apos;s own transcript and the source video, not
          generated copy. Edit freely — it is saved as you left it.
        </p>
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
            checked={cartoonEnabled}
            onChange={(e) => setCartoonEnabled(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          🎨 Cartoon style (AI)
        </label>
        {cartoonEnabled && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Look</Label>
                <select
                  value={cartoonStyle}
                  onChange={(e) => setCartoonStyle(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-surface-raised px-2 text-sm"
                >
                  <option value="hayao">Soft anime (Ghibli-like)</option>
                  <option value="shinkai">Vivid anime (high contrast)</option>
                </select>
              </div>
              <div>
                <Label>Animation rate</Label>
                <select
                  value={cartoonFps}
                  onChange={(e) => setCartoonFps(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-surface-raised px-2 text-sm"
                >
                  <option value="8">8 fps — most hand-drawn</option>
                  <option value="12">12 fps — classic animation</option>
                  <option value="24">24 fps — smooth (slower)</option>
                </select>
              </div>
            </div>
            <div>
              <Label>Detail</Label>
              <select
                value={cartoonQuality}
                onChange={(e) => setCartoonQuality(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-surface-raised px-2 text-sm"
              >
                <option value="high">
                  High — drawn at full export size (sharpest)
                </option>
                <option value="standard">Standard — 512px draft (≈4x faster)</option>
              </select>
            </div>
            <p className="text-xs text-warning">
              Redraws every frame with a local AI model. At High detail expect
              roughly 1½ minutes per 10s of clip at 12 fps; Standard is a quick
              draft. Captions and the banner stay sharp on top either way.
              Can&apos;t be combined with background removal.
            </p>
          </>
        )}
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
