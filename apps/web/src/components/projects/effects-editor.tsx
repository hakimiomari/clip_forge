"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, Sparkles, Trash2, Wand2, MousePointerClick } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";

/** Mirrors shared-types RangeEffect (kept loose client-side). */
export interface EffectItem {
  id: string;
  type:
    | "slow_motion"
    | "speed_up"
    | "freeze_frame"
    | "color_grade"
    | "punch_in"
    | "flash"
    | "glow_trail";
  start?: number;
  end?: number;
  factor?: number;
  holdSeconds?: number;
  preset?: string;
  keyframes?: Array<{ t: number; x: number; y: number }>;
  color?: string;
  size?: number;
}

const TYPE_LABELS: Record<EffectItem["type"], string> = {
  slow_motion: "Slow motion",
  speed_up: "Speed up",
  freeze_frame: "Freeze frame",
  color_grade: "Color grade",
  punch_in: "Punch-in zoom",
  flash: "Impact flash",
  glow_trail: "Glow trail (track object)",
};

const COLOR_PRESETS = [
  { value: "cinematic", label: "Cinematic" },
  { value: "warm", label: "Warm" },
  { value: "cool", label: "Cool" },
  { value: "black_white", label: "Black & white" },
  { value: "vivid", label: "Vivid" },
];

function summarize(e: EffectItem): string {
  const range = e.end !== undefined ? `${e.start}s–${e.end}s` : `${e.start}s`;
  switch (e.type) {
    case "slow_motion":
      return `${range} at ${e.factor}× speed`;
    case "speed_up":
      return `${range} at ${e.factor}× speed`;
    case "freeze_frame":
      return `hold frame at ${e.start}s for ${e.holdSeconds}s`;
    case "color_grade":
      return `${range} · ${e.preset?.replace("_", " ")}`;
    case "punch_in":
      return `${range} · zoom ${e.factor}×`;
    case "flash":
      return `flash at ${e.start}s`;
    case "glow_trail":
      return `${e.keyframes?.length ?? 0} tracked points`;
  }
}

export function EffectsEditor({
  clipId,
  clipDuration,
  previewUrl,
  initialEffects,
  onSaved,
}: {
  clipId: string;
  clipDuration: number;
  previewUrl: string | null;
  initialEffects: EffectItem[];
  onSaved: (rendered: boolean) => void;
}) {
  const [effects, setEffects] = useState<EffectItem[]>(initialEffects);
  const [error, setError] = useState<string | null>(null);

  // ── add-effect form state ────────────────────────────
  const [type, setType] = useState<EffectItem["type"]>("slow_motion");
  const [start, setStart] = useState("2");
  const [end, setEnd] = useState("5");
  const [factor, setFactor] = useState("0.5");
  const [hold, setHold] = useState("1.5");
  const [preset, setPreset] = useState("cinematic");
  const [keyframes, setKeyframes] = useState<Array<{ t: number; x: number; y: number }>>([]);
  const videoRef = useRef<HTMLVideoElement>(null);

  const outputDuration = useMemo(() => {
    let delta = 0;
    for (const e of effects) {
      if (e.type === "slow_motion" || e.type === "speed_up") {
        const len = (e.end ?? 0) - (e.start ?? 0);
        delta += len / (e.factor ?? 1) - len;
      } else if (e.type === "freeze_frame") {
        delta += e.holdSeconds ?? 0;
      }
    }
    return clipDuration + delta;
  }, [effects, clipDuration]);

  const save = useMutation({
    mutationFn: async (opts: { renderAfter: boolean }) => {
      await api(`/clips/${clipId}/effects`, {
        method: "PATCH",
        body: { effects },
      });
      if (opts.renderAfter) {
        await api(`/clips/${clipId}/render`, { method: "POST" });
      }
      return opts.renderAfter;
    },
    onSuccess: (rendered) => onSaved(rendered),
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  const addEffect = () => {
    setError(null);
    const id = `fx_${Date.now()}`;
    const s = Number(start);
    const en = Number(end);
    let item: EffectItem | null = null;
    switch (type) {
      case "slow_motion":
        item = { id, type, start: s, end: en, factor: Number(factor) || 0.5 };
        break;
      case "speed_up":
        item = { id, type, start: s, end: en, factor: Number(factor) || 2 };
        break;
      case "freeze_frame":
        item = { id, type, start: s, holdSeconds: Number(hold) || 1.5 };
        break;
      case "color_grade":
        item = { id, type, start: s, end: en, preset };
        break;
      case "punch_in":
        item = { id, type, start: s, end: en, factor: Number(factor) || 1.35 };
        break;
      case "flash":
        item = { id, type, start: s };
        break;
      case "glow_trail":
        if (keyframes.length < 2) {
          setError("Click the object on the preview at least twice (different moments).");
          return;
        }
        item = { id, type, keyframes: [...keyframes] };
        break;
    }
    if (item) {
      setEffects((prev) => [
        ...prev.filter((e) => !(type === "glow_trail" && e.type === "glow_trail")),
        item as EffectItem,
      ]);
      if (type === "glow_trail") setKeyframes([]);
    }
  };

  const captureKeyframe = (ev: React.MouseEvent<HTMLVideoElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const rect = video.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
    const t = Math.round(video.currentTime * 100) / 100;
    setKeyframes((prev) =>
      [...prev.filter((k) => Math.abs(k.t - t) > 0.05), { t, x, y }].sort(
        (a, b) => a.t - b.t,
      ),
    );
  };

  const rangedType = ["slow_motion", "speed_up", "color_grade", "punch_in"].includes(type);
  const factorType = ["slow_motion", "speed_up", "punch_in"].includes(type);

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex items-center gap-2">
        <Wand2 className="h-4 w-4 text-accent" />
        <h5 className="text-sm font-semibold">Advanced effects</h5>
        <span className="ml-auto text-xs text-muted">
          Output: ~{outputDuration.toFixed(1)}s
        </span>
      </div>

      {effects.length > 0 && (
        <div className="space-y-1.5">
          {effects.map((e) => (
            <div
              key={e.id}
              className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
            >
              <span>
                <span className="font-medium">{TYPE_LABELS[e.type]}</span>{" "}
                <span className="text-muted">· {summarize(e)}</span>
              </span>
              <button
                className="text-muted hover:text-danger"
                onClick={() => setEffects((prev) => prev.filter((x) => x.id !== e.id))}
                aria-label="Remove effect"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border border-dashed border-border-strong p-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <Label>Effect type</Label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as EffectItem["type"])}
              className="h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm"
            >
              {Object.entries(TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>

          {type !== "glow_trail" && (
            <div>
              <Label>{type === "freeze_frame" ? "Freeze at (s)" : "Start (s)"}</Label>
              <Input value={start} onChange={(e) => setStart(e.target.value)} className="h-9" />
            </div>
          )}
          {rangedType && (
            <div>
              <Label>End (s)</Label>
              <Input value={end} onChange={(e) => setEnd(e.target.value)} className="h-9" />
            </div>
          )}
          {factorType && (
            <div>
              <Label>
                {type === "slow_motion"
                  ? "Speed (0.25–0.9)"
                  : type === "speed_up"
                    ? "Speed (1.1–4)"
                    : "Zoom (1.1–2)"}
              </Label>
              <Input value={factor} onChange={(e) => setFactor(e.target.value)} className="h-9" />
            </div>
          )}
          {type === "freeze_frame" && (
            <div>
              <Label>Hold (s)</Label>
              <Input value={hold} onChange={(e) => setHold(e.target.value)} className="h-9" />
            </div>
          )}
          {type === "color_grade" && (
            <div>
              <Label>Preset</Label>
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm"
              >
                {COLOR_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {type === "glow_trail" && (
          <div className="mt-3">
            {previewUrl ? (
              <>
                <p className="mb-2 flex items-center gap-1.5 text-xs text-muted">
                  <MousePointerClick className="h-3.5 w-3.5" />
                  Play or scrub, then <b>click the object</b> (e.g. the ball) at
                  2–10 different moments. The trail follows your clicks.
                </p>
                <video
                  ref={videoRef}
                  src={previewUrl}
                  controls
                  onClick={captureKeyframe}
                  className="max-h-72 w-full cursor-crosshair rounded-md bg-black"
                />
                {keyframes.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {keyframes.map((k) => (
                      <span
                        key={k.t}
                        className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs text-accent"
                      >
                        {k.t.toFixed(2)}s
                        <button
                          onClick={() =>
                            setKeyframes((prev) => prev.filter((x) => x.t !== k.t))
                          }
                          className="hover:text-danger"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-warning">
                Render the clip once first — the trail is keyframed by clicking
                on the rendered preview.
              </p>
            )}
          </div>
        )}

        <Button size="sm" variant="secondary" className="mt-3" onClick={addEffect}>
          <Plus className="h-3.5 w-3.5" />
          Add effect
        </Button>
      </div>

      <FieldError message={error ?? undefined} />

      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ renderAfter: true })}>
          <Sparkles className="h-3.5 w-3.5" />
          Apply & re-render
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
      <p
        className={cn(
          "text-xs text-muted",
          Math.abs(outputDuration - clipDuration) > 0.1 && "text-muted-strong",
        )}
      >
        Slow motion, speed-up and freezes change the clip length — captions
        re-time automatically. Times refer to the clip (0s = clip start).
      </p>
    </div>
  );
}
