"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Clapperboard,
  Pause,
  Play,
  Plus,
  Scissors,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  MAX_CLIP_PARTS,
  type FilmstripInfo,
  type HighlightSummary,
} from "@clipforge/shared-types";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { FieldError, Input } from "@/components/ui/input";
import { MediaPreview, type PlayerHandle } from "./media-preview";

/** Mirrors the API's clip limits (clips.service.ts). */
const MIN_CLIP_SECONDS = 5;
const MAX_CLIP_SECONDS = 240;
const DEFAULT_SELECTION_SECONDS = 30;
const MAX_ZOOM = 60;
/** Track height in px — must match the `h-20` on the frame strip. */
const TRACK_HEIGHT = 80;

/** mm:ss.d — tenths matter when trimming to a beat. */
function formatPreciseTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = s.toFixed(1).padStart(4, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Tick spacing that keeps labels readable at the current zoom. */
function pickTickStep(visibleSeconds: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => visibleSeconds / s <= 10) ?? 7200;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type DragMode = "start" | "end" | "move" | "scrub";

export function TimelineEditor({
  projectId,
  duration,
  mediaUrl,
  youtubeId,
  poster,
  highlights,
  captionStyle = "bold_dynamic",
}: {
  projectId: string;
  duration: number;
  mediaUrl: string | null;
  youtubeId: string | null;
  poster: string | null;
  highlights: HighlightSummary[];
  captionStyle?: string;
}) {
  const queryClient = useQueryClient();
  const playerRef = useRef<PlayerHandle>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState(() => ({
    start: 0,
    end: Math.min(DEFAULT_SELECTION_SECONDS, Math.max(MIN_CLIP_SECONDS, duration)),
  }));
  /** Extra parts added before the current selection; played in order. */
  const [parts, setParts] = useState<Array<{ start: number; end: number }>>([]);
  const [name, setName] = useState("");
  const [format, setFormat] = useState("vertical");
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [zoomEffect, setZoomEffect] = useState(true);
  const [backgroundMode, setBackgroundMode] = useState("blur");
  const [ctaEnabled, setCtaEnabled] = useState(true);
  const [cartoonEnabled, setCartoonEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dragRef = useRef<{ mode: DragMode; grabOffset: number } | null>(null);
  /** Set while previewing just the selection, so playback stops at its end. */
  const stopAtRef = useRef<number | null>(null);

  const selectionLength = selection.end - selection.start;
  const maxLength = Math.min(MAX_CLIP_SECONDS, duration);
  const partsLength = parts.reduce((sum, p) => sum + (p.end - p.start), 0);
  /** What the clip will actually contain: saved parts, or the selection. */
  const clipParts = parts.length > 0 ? parts : [selection];
  const clipLength = parts.length > 0 ? partsLength : selectionLength;

  // ── Filmstrip: request once, then poll while it builds ───
  const { data: filmstrip } = useQuery({
    queryKey: ["filmstrip", projectId],
    queryFn: () => api<FilmstripInfo>(`/projects/${projectId}/filmstrip`),
    refetchInterval: (query) =>
      query.state.data?.status === "PENDING" ? 3000 : false,
  });

  const requestFilmstrip = useMutation({
    mutationFn: () =>
      api<FilmstripInfo>(`/projects/${projectId}/filmstrip`, { method: "POST" }),
    onSuccess: (data) =>
      queryClient.setQueryData(["filmstrip", projectId], data),
  });

  const filmstripStatus = filmstrip?.status;
  const requestStrip = requestFilmstrip.mutate;
  useEffect(() => {
    if (filmstripStatus === "NONE") requestStrip();
  }, [filmstripStatus, requestStrip]);

  // ── Selection helpers ────────────────────────────────────
  const setStartAt = useCallback(
    (time: number) => {
      setSelection((prev) => {
        const start = clamp(time, 0, duration - MIN_CLIP_SECONDS);
        // Keep the window legal by pushing the end, never inverting it
        const end = clamp(prev.end, start + MIN_CLIP_SECONDS, Math.min(duration, start + maxLength));
        return { start, end };
      });
    },
    [duration, maxLength],
  );

  const setEndAt = useCallback(
    (time: number) => {
      setSelection((prev) => {
        const end = clamp(time, MIN_CLIP_SECONDS, duration);
        const start = clamp(prev.start, Math.max(0, end - maxLength), end - MIN_CLIP_SECONDS);
        return { start, end };
      });
    },
    [duration, maxLength],
  );

  const seek = useCallback((time: number) => {
    const target = Math.max(0, time);
    playerRef.current?.seek(target);
    setCurrentTime(target);
  }, []);

  const togglePlay = useCallback(() => {
    stopAtRef.current = null;
    if (playing) playerRef.current?.pause();
    else playerRef.current?.play();
  }, [playing]);

  const previewSelection = useCallback(() => {
    stopAtRef.current = selection.end;
    playerRef.current?.seek(selection.start);
    playerRef.current?.play();
  }, [selection.start, selection.end]);

  const handleTime = useCallback((time: number) => {
    setCurrentTime(time);
    const stopAt = stopAtRef.current;
    if (stopAt !== null && time >= stopAt) {
      stopAtRef.current = null;
      playerRef.current?.pause();
    }
  }, []);

  // ── Pointer → time, accounting for zoom and scroll ───────
  const timeAtClientX = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0;
      return clamp(((clientX - rect.left) / rect.width) * duration, 0, duration);
    },
    [duration],
  );

  const beginDrag = (mode: DragMode) => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const time = timeAtClientX(event.clientX);
    dragRef.current = {
      mode,
      grabOffset: mode === "move" ? time - selection.start : 0,
    };
    if (mode === "scrub") seek(time);
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const time = timeAtClientX(event.clientX);
      if (drag.mode === "start") setStartAt(time);
      else if (drag.mode === "end") setEndAt(time);
      else if (drag.mode === "scrub") seek(time);
      else {
        setSelection((prev) => {
          const length = prev.end - prev.start;
          const start = clamp(time - drag.grabOffset, 0, duration - length);
          return { start, end: start + length };
        });
      }
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [duration, seek, setEndAt, setStartAt, timeAtClientX]);

  // ── Keyboard shortcuts ───────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const step = event.shiftKey ? 0.1 : event.altKey ? 10 : 1;
      switch (event.key.toLowerCase()) {
        case " ":
          event.preventDefault();
          togglePlay();
          break;
        case "i":
          event.preventDefault();
          setStartAt(playerRef.current?.getTime() ?? currentTime);
          break;
        case "o":
          event.preventDefault();
          setEndAt(playerRef.current?.getTime() ?? currentTime);
          break;
        case "arrowleft":
          event.preventDefault();
          seek((playerRef.current?.getTime() ?? currentTime) - step);
          break;
        case "arrowright":
          event.preventDefault();
          seek((playerRef.current?.getTime() ?? currentTime) + step);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentTime, seek, setEndAt, setStartAt, togglePlay]);

  // Keep the playhead in view while playing a zoomed-in timeline
  useEffect(() => {
    if (!playing || zoom === 1) return;
    const scroller = scrollRef.current;
    const track = trackRef.current;
    if (!scroller || !track) return;
    const x = (currentTime / duration) * track.clientWidth;
    if (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth - 40) {
      scroller.scrollLeft = x - scroller.clientWidth / 2;
    }
  }, [currentTime, duration, playing, zoom]);

  const zoomToSelection = () => {
    const target = clamp(duration / Math.max(selectionLength * 1.4, 1), 1, MAX_ZOOM);
    setZoom(target);
    requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      const track = trackRef.current;
      if (!scroller || !track) return;
      const mid = ((selection.start + selection.end) / 2 / duration) * track.clientWidth;
      scroller.scrollLeft = mid - scroller.clientWidth / 2;
    });
  };

  const createClip = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/clips`, {
        method: "POST",
        body: {
          segments: clipParts.map((p) => ({
            sourceStart: Number(p.start.toFixed(2)),
            sourceEnd: Number(p.end.toFixed(2)),
          })),
          name: name.trim() || undefined,
          format,
          captionsEnabled,
          captionStyle,
          zoomEnabled: zoomEffect,
          backgroundMode,
          ctaEnabled,
          ...(cartoonEnabled
            ? { cartoon: { enabled: true, style: "hayao", fps: 12 } }
            : {}),
        },
      }),
    onSuccess: () => {
      setError(null);
      setName("");
      setParts([]);
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });

  const addPart = () => {
    if (parts.length >= MAX_CLIP_PARTS) return;
    setParts((prev) => [...prev, { ...selection }]);
    // Park the selection after the part just added, ready for the next one
    const nextStart = Math.min(selection.end, duration - MIN_CLIP_SECONDS);
    setSelection({
      start: Math.max(0, nextStart),
      end: Math.min(duration, Math.max(0, nextStart) + selectionLength),
    });
  };

  const movePart = (index: number, delta: number) =>
    setParts((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  // The track's pixel width drives how many thumbnails fit; it changes
  // with zoom and with the window.
  const [trackWidth, setTrackWidth] = useState(0);
  useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setTrackWidth(width);
    });
    observer.observe(el);
    setTrackWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  /**
   * Thumbnails are drawn at their true aspect ratio and each one stands
   * for the slice of time under it — stretching one cell per captured
   * frame would squash them into slivers on a wide timeline.
   */
  const frameCells = useMemo(() => {
    if (
      !filmstrip ||
      filmstrip.status !== "READY" ||
      !filmstrip.url ||
      filmstrip.count === 0 ||
      filmstrip.interval <= 0 ||
      trackWidth === 0
    ) {
      return [];
    }
    const aspect =
      filmstrip.frameHeight > 0
        ? filmstrip.frameWidth / filmstrip.frameHeight
        : 16 / 9;
    const cellWidth = TRACK_HEIGHT * aspect;
    const cellCount = Math.max(1, Math.ceil(trackWidth / cellWidth));
    return Array.from({ length: cellCount }, (_, i) => {
      const centerTime = ((i + 0.5) / cellCount) * duration;
      const frame = clamp(
        Math.round(centerTime / filmstrip.interval - 0.5),
        0,
        filmstrip.count - 1,
      );
      return { left: i * cellWidth, width: cellWidth, frame };
    });
  }, [filmstrip, trackWidth, duration]);

  const ticks = useMemo(() => {
    const visible = duration / zoom;
    const step = pickTickStep(visible);
    const out: number[] = [];
    for (let t = 0; t <= duration; t += step) out.push(t);
    return out;
  }, [duration, zoom]);

  const percent = (time: number) => `${(time / duration) * 100}%`;
  const tooShort = clipLength < MIN_CLIP_SECONDS;
  const tooLong = clipLength > MAX_CLIP_SECONDS;
  const estimatedCredits = Math.max(2, Math.ceil(clipLength / 30) * 2);

  return (
    <Card className="p-0">
      <div className="aspect-video w-full overflow-hidden rounded-t-xl bg-black">
        <MediaPreview
          ref={playerRef}
          mediaUrl={mediaUrl}
          youtubeId={youtubeId}
          poster={poster}
          onTime={handleTime}
          onPlayingChange={setPlaying}
        />
      </div>

      <div className="space-y-4 p-5">
        {/* ── Transport ─────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <span className="font-mono text-sm tabular-nums">
            {formatPreciseTime(currentTime)}
            <span className="text-muted"> / {formatPreciseTime(duration)}</span>
          </span>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button size="sm" variant="secondary" onClick={() => setStartAt(currentTime)} title="Set start at playhead (I)">
            Set start
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEndAt(currentTime)} title="Set end at playhead (O)">
            Set end
          </Button>
          <Button size="sm" variant="ghost" onClick={previewSelection}>
            <Scissors className="h-4 w-4" />
            Preview selection
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setZoom((z) => clamp(z / 2, 1, MAX_ZOOM))}
              disabled={zoom <= 1}
              aria-label="Zoom out"
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setZoom((z) => clamp(z * 2, 1, MAX_ZOOM))}
              disabled={zoom >= MAX_ZOOM}
              aria-label="Zoom in"
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={zoomToSelection}>
              Fit selection
            </Button>
          </div>
        </div>

        {/* ── Timeline track ────────────────────────────── */}
        <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden pb-1">
          <div
            ref={trackRef}
            className="relative select-none"
            style={{ width: `${zoom * 100}%`, minWidth: "100%" }}
          >
            {/* Ruler */}
            <div className="relative h-5 border-b border-border">
              {ticks.map((t) => (
                <div
                  key={t}
                  className="absolute top-0 h-full border-l border-border pl-1 text-[10px] leading-5 text-muted"
                  style={{ left: percent(t) }}
                >
                  {formatPreciseTime(t).replace(/\.\d$/, "")}
                </div>
              ))}
            </div>

            {/* Frames + selection */}
            <div
              className="relative h-20 cursor-pointer bg-surface-raised"
              onPointerDown={beginDrag("scrub")}
            >
              {/* Frames are clipped on their own layer so the handles,
                  which sit at the very edges, stay clickable. */}
              <div className="absolute inset-0 overflow-hidden">
                {frameCells.length > 0 && filmstrip?.url ? (
                  frameCells.map((cell, i) => (
                    <div
                      key={i}
                      data-frame-cell
                      className="absolute top-0 h-full"
                      style={{
                        left: `${cell.left}px`,
                        width: `${cell.width}px`,
                        backgroundImage: `url(${filmstrip.url})`,
                        backgroundSize: `${filmstrip.columns * 100}% ${filmstrip.rows * 100}%`,
                        backgroundPosition: `${
                          filmstrip.columns > 1
                            ? ((cell.frame % filmstrip.columns) / (filmstrip.columns - 1)) * 100
                            : 0
                        }% ${
                          filmstrip.rows > 1
                            ? (Math.floor(cell.frame / filmstrip.columns) / (filmstrip.rows - 1)) * 100
                            : 0
                        }%`,
                      }}
                    />
                  ))
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted">
                    {filmstrip?.status === "PENDING"
                      ? "Building timeline frames…"
                      : filmstrip?.status === "FAILED"
                        ? "Frame previews unavailable — you can still select a range"
                        : "Loading timeline…"}
                  </div>
                )}
              </div>

              {/* AI highlight markers */}
              {highlights.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  title={`${h.title ?? "Highlight"} — click to select`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() =>
                    setSelection({
                      start: clamp(h.startTime, 0, duration - MIN_CLIP_SECONDS),
                      end: clamp(h.endTime, h.startTime + MIN_CLIP_SECONDS, duration),
                    })
                  }
                  className="absolute bottom-0 h-2 rounded-sm bg-accent/70 hover:bg-accent"
                  style={{
                    left: percent(h.startTime),
                    width: percent(Math.max(h.endTime - h.startTime, 0.5)),
                  }}
                />
              ))}

              {/* Played-so-far shading, so the timeline doubles as a
                  progress bar while the video plays */}
              <div
                className="pointer-events-none absolute top-0 h-full bg-white/10"
                style={{ left: 0, width: percent(currentTime) }}
              />

              {/* Parts already added to this clip */}
              {parts.map((part, i) => (
                <div
                  key={`${part.start}-${part.end}-${i}`}
                  className="pointer-events-none absolute bottom-2 top-2 rounded border border-accent bg-accent/30"
                  style={{
                    left: percent(part.start),
                    width: percent(Math.max(part.end - part.start, 0.2)),
                  }}
                  title={`Part ${i + 1}: ${formatPreciseTime(part.start)} → ${formatPreciseTime(part.end)}`}
                >
                  <span className="absolute left-1 top-0 text-[10px] font-bold text-accent">
                    {i + 1}
                  </span>
                </div>
              ))}

              {/* Dimmed area outside the selection */}
              <div
                className="pointer-events-none absolute top-0 h-full bg-black/60"
                style={{ left: 0, width: percent(selection.start) }}
              />
              <div
                className="pointer-events-none absolute top-0 h-full bg-black/60"
                style={{ left: percent(selection.end), right: 0 }}
              />

              {/* Selection window */}
              <div
                className={cn(
                  "absolute top-0 h-full cursor-grab border-y-2 active:cursor-grabbing",
                  tooShort || tooLong ? "border-danger bg-danger/10" : "border-primary bg-primary/10",
                )}
                style={{ left: percent(selection.start), width: percent(selectionLength) }}
                onPointerDown={beginDrag("move")}
              />
              {/* Handles hang inside the selection so a clip starting at
                  0 or ending on the last frame stays fully grabbable. */}
              <div
                className="absolute top-0 h-full w-3 cursor-ew-resize rounded-l bg-primary"
                style={{ left: percent(selection.start) }}
                onPointerDown={beginDrag("start")}
                role="slider"
                aria-label="Clip start"
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={selection.start}
                tabIndex={0}
              />
              <div
                className="absolute top-0 h-full w-3 -translate-x-full cursor-ew-resize rounded-r bg-primary"
                style={{ left: percent(selection.end) }}
                onPointerDown={beginDrag("end")}
                role="slider"
                aria-label="Clip end"
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={selection.end}
                tabIndex={0}
              />

              {/* Playhead — tracks playback live */}
              <div
                data-testid="timeline-playhead"
                className="pointer-events-none absolute top-0 h-full w-0.5 bg-white"
                style={{ left: percent(currentTime) }}
              >
                <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-white" />
              </div>
            </div>
          </div>
        </div>

        {/* ── Selection summary ─────────────────────────── */}
        <div className="flex flex-wrap items-end gap-4">
          <TimeField
            label="Start"
            value={selection.start}
            onChange={setStartAt}
            onSeek={seek}
            max={duration}
          />
          <TimeField
            label="End"
            value={selection.end}
            onChange={setEndAt}
            onSeek={seek}
            max={duration}
          />
          <div className="text-sm">
            <span className="text-muted">Selection </span>
            <span className="font-semibold tabular-nums">
              {selectionLength.toFixed(1)}s
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={addPart}
            disabled={parts.length >= MAX_CLIP_PARTS}
            title={
              parts.length >= MAX_CLIP_PARTS
                ? `A clip can hold at most ${MAX_CLIP_PARTS} parts`
                : "Add this selection as another part of the clip"
            }
          >
            <Plus className="h-4 w-4" />
            Add as part
          </Button>
        </div>

        {/* ── Parts of this clip ────────────────────────── */}
        {parts.length > 0 && (
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">
                Clip parts ({parts.length}) — played in this order
              </span>
              <Button size="sm" variant="ghost" onClick={() => setParts([])}>
                Clear all
              </Button>
            </div>
            <ul className="space-y-1.5">
              {parts.map((part, i) => (
                <li
                  key={`${part.start}-${part.end}-${i}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-accent/20 text-xs font-bold text-accent">
                    {i + 1}
                  </span>
                  <span className="font-mono tabular-nums">
                    {formatPreciseTime(part.start)} → {formatPreciseTime(part.end)}
                  </span>
                  <span className="text-xs text-muted">
                    {(part.end - part.start).toFixed(1)}s
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelection({ ...part })}
                      title="Load this part into the selection"
                    >
                      Show
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => movePart(i, -1)}
                      disabled={i === 0}
                      aria-label={`Move part ${i + 1} earlier`}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => movePart(i, 1)}
                      disabled={i === parts.length - 1}
                      aria-label={`Move part ${i + 1} later`}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setParts((prev) => prev.filter((_, j) => j !== i))}
                      aria-label={`Remove part ${i + 1}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="text-sm">
          <span className="text-muted">
            {parts.length > 0 ? `Clip length (${parts.length} parts) ` : "Clip length "}
          </span>
          <span
            className={cn(
              "font-semibold tabular-nums",
              (tooShort || tooLong) && "text-danger",
            )}
          >
            {clipLength.toFixed(1)}s
          </span>
          <span className="ml-2 text-xs text-muted">≈ {estimatedCredits} credits</span>
        </div>

        {/* ── Clip options ──────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Clip name (optional)"
            className="h-8 w-48"
          />
          <label className="flex items-center gap-2">
            <span className="text-muted">Format:</span>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className="h-8 rounded-lg border border-border bg-surface-raised px-2 text-sm"
            >
              <option value="vertical">Vertical 9:16</option>
              <option value="square">Square 1:1</option>
              <option value="landscape">Landscape 16:9</option>
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={captionsEnabled}
              onChange={(e) => setCaptionsEnabled(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Captions
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={zoomEffect}
              onChange={(e) => setZoomEffect(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Slow zoom
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={ctaEnabled}
              onChange={(e) => setCtaEnabled(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            ♥ Like &amp; Follow banner
          </label>
          <label
            className="flex cursor-pointer items-center gap-2"
            title="Redraws every frame as anime with a local AI model — slower render"
          >
            <input
              type="checkbox"
              checked={cartoonEnabled}
              onChange={(e) => setCartoonEnabled(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            🎨 Cartoon style
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted">Background:</span>
            <select
              value={backgroundMode}
              onChange={(e) => setBackgroundMode(e.target.value)}
              className="h-8 rounded-lg border border-border bg-surface-raised px-2 text-sm"
            >
              <option value="blur">Blurred bars</option>
              <option value="fill">Fill screen (crop sides)</option>
              <option value="black">Black bars</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            Drag the handles or press <kbd className="rounded border border-border px-1">I</kbd> /{" "}
            <kbd className="rounded border border-border px-1">O</kbd> to set start and end at the
            playhead. <kbd className="rounded border border-border px-1">Space</kbd> plays, arrows
            step (hold Shift for 0.1s).
          </p>
          <Button
            onClick={() => createClip.mutate()}
            loading={createClip.isPending}
            disabled={tooShort || tooLong}
          >
            <Clapperboard className="h-4 w-4" />
            {parts.length > 0
              ? `Create clip from ${parts.length} parts`
              : "Create clip from selection"}
          </Button>
        </div>

        {tooShort && (
          <FieldError message={`Select at least ${MIN_CLIP_SECONDS} seconds.`} />
        )}
        {tooLong && (
          <FieldError message={`Clips are limited to ${MAX_CLIP_SECONDS} seconds.`} />
        )}
        <FieldError message={error ?? undefined} />
      </div>
    </Card>
  );
}

/** Numeric seconds field that also jumps the playhead to that point. */
function TimeField({
  label,
  value,
  onChange,
  onSeek,
  max,
}: {
  label: string;
  value: number;
  onChange: (seconds: number) => void;
  onSeek: (seconds: number) => void;
  max: number;
}) {
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-muted-strong">{label}</span>
      <div className="flex items-center gap-1">
        <Input
          type="number"
          step={0.1}
          min={0}
          max={max}
          value={value.toFixed(1)}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
          className="h-8 w-24 font-mono tabular-nums"
        />
        <Button size="sm" variant="ghost" onClick={() => onSeek(value)} title={`Jump to ${label.toLowerCase()}`}>
          {formatPreciseTime(value)}
        </Button>
      </div>
    </div>
  );
}
