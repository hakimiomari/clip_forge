"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Wand2 } from "lucide-react";
import { REEL_LENGTHS } from "@clipforge/shared-types";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Label, FieldError } from "@/components/ui/input";

const LENGTHS = [15, 30, 45, 60, 90] as const;
const COUNTS = [1, 3, 5, 10] as const;
const CAPTION_STYLES = [
  { value: "bold_dynamic", label: "Bold dynamic" },
  { value: "minimal", label: "Minimal" },
  { value: "professional", label: "Professional" },
  { value: "podcast", label: "Podcast" },
  { value: "news", label: "News" },
] as const;

/** Mirrors renderCost() on the server: 2 credits per started 30s. */
function renderCost(seconds: number): number {
  return Math.max(2, Math.ceil(seconds / 30) * 2);
}

/**
 * Automatic mode: find the moments *and* render a finished short for
 * each one, in a single run that continues if the page is closed.
 */
export function AutoShortsCard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"separate" | "merged">("separate");
  const [reelSeconds, setReelSeconds] = useState<number>(90);
  const [length, setLength] = useState<number>(30);
  const [count, setCount] = useState<number>(3);
  const [format, setFormat] = useState("vertical");
  const [captionStyle, setCaptionStyle] = useState("bold_dynamic");
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [zoomEnabled, setZoomEnabled] = useState(true);
  const [backgroundMode, setBackgroundMode] = useState("blur");
  const [ctaEnabled, setCtaEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const merged = mode === "merged";
  const renderCredits = merged
    ? renderCost(reelSeconds)
    : count * renderCost(length);
  const totalCredits = 2 + renderCredits;

  const run = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/highlights/generate`, {
        method: "POST",
        body: {
          clipDuration: length,
          clipCount: count,
          format,
          captionStyle,
          autoCreateClips: true,
          mergeIntoOne: merged,
          reelSeconds,
          captionsEnabled,
          zoomEnabled,
          backgroundMode,
          ctaEnabled,
        },
      }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <Card className="border-accent/40">
      <div className="flex items-center gap-2">
        <Wand2 className="h-5 w-5 text-accent" />
        <CardTitle>Automatic shorts</CardTitle>
      </div>
      <CardDescription className="mt-1">
        {merged
          ? "One run: ClipForge finds the best moments and joins them, in the order they happen, into one video."
          : "One run: ClipForge finds the best moments and renders a finished short for each one."}{" "}
        You can close the page — it keeps going.
      </CardDescription>

      <div className="mt-5 space-y-4">
        <div>
          <Label>What to make</Label>
          <div className="flex flex-wrap gap-2">
            <OptionChip active={!merged} onClick={() => setMode("separate")}>
              Separate shorts
            </OptionChip>
            <OptionChip active={merged} onClick={() => setMode("merged")}>
              One best-moments video
            </OptionChip>
          </div>
        </div>
        {merged ? (
          <div>
            <Label>Video length</Label>
            <div className="flex flex-wrap gap-2">
              {REEL_LENGTHS.map((l) => (
                <OptionChip
                  key={l}
                  active={reelSeconds === l}
                  onClick={() => setReelSeconds(l)}
                >
                  {l < 120 ? `${l}s` : `${l / 60} min`}
                </OptionChip>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div>
              <Label>Length of each short</Label>
              <div className="flex flex-wrap gap-2">
                {LENGTHS.map((l) => (
                  <OptionChip
                    key={l}
                    active={length === l}
                    onClick={() => setLength(l)}
                  >
                    {l}s
                  </OptionChip>
                ))}
              </div>
            </div>
            <div>
              <Label>How many shorts</Label>
              <div className="flex flex-wrap gap-2">
                {COUNTS.map((c) => (
                  <OptionChip
                    key={c}
                    active={count === c}
                    onClick={() => setCount(c)}
                  >
                    {c}
                  </OptionChip>
                ))}
              </div>
            </div>
          </>
        )}
        <div>
          <Label>Format</Label>
          <div className="flex flex-wrap gap-2">
            {[
              { value: "vertical", label: "Vertical 9:16" },
              { value: "square", label: "Square 1:1" },
              { value: "landscape", label: "Landscape 16:9" },
            ].map((f) => (
              <OptionChip
                key={f.value}
                active={format === f.value}
                onClick={() => setFormat(f.value)}
              >
                {f.label}
              </OptionChip>
            ))}
          </div>
        </div>
        <div>
          <Label>Caption style</Label>
          <div className="flex flex-wrap gap-2">
            {CAPTION_STYLES.map((s) => (
              <OptionChip
                key={s.value}
                active={captionStyle === s.value}
                onClick={() => setCaptionStyle(s.value)}
              >
                {s.label}
              </OptionChip>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
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
              checked={zoomEnabled}
              onChange={(e) => setZoomEnabled(e.target.checked)}
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
            ♥ Banner
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted">Background:</span>
            <select
              value={backgroundMode}
              onChange={(e) => setBackgroundMode(e.target.value)}
              className="h-8 rounded-lg border border-border bg-surface-raised px-2 text-sm"
            >
              <option value="blur">Blurred bars</option>
              <option value="fill">Fill screen</option>
              <option value="black">Black bars</option>
            </select>
          </label>
        </div>

        <Button
          className="w-full"
          onClick={() => run.mutate()}
          loading={run.isPending}
        >
          <Wand2 className="h-4 w-4" />
          {merged
            ? "Make my best-moments video"
            : `Make ${count} short${count === 1 ? "" : "s"} automatically`}
        </Button>
        <p className="text-center text-xs text-muted">
          {merged
            ? `${totalCredits} credits (2 to find the moments, ${renderCredits} to render). Returned in part if the video comes out shorter.`
            : `${totalCredits} credits (2 to find the moments, ${renderCost(length)} per short). Unused credits are returned if fewer moments are found.`}
        </p>
        <FieldError message={error ?? undefined} />
      </div>
    </Card>
  );
}

function OptionChip({
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
          ? "border-accent bg-accent/15 text-accent"
          : "border-border text-muted hover:border-border-strong hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
