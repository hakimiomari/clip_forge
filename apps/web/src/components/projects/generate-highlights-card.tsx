"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { GenerateHighlightsInput } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Label, FieldError } from "@/components/ui/input";

const DURATIONS = [30, 45, 60, 90, 120] as const;
const COUNTS = [1, 3, 5, 10] as const;
const CAPTION_STYLES = [
  { value: "bold_dynamic", label: "Bold dynamic" },
  { value: "minimal", label: "Minimal" },
  { value: "professional", label: "Professional" },
  { value: "podcast", label: "Podcast" },
  { value: "news", label: "News" },
] as const;

export function GenerateHighlightsCard({
  projectId,
  hasHighlights,
}: {
  projectId: string;
  hasHighlights: boolean;
}) {
  const queryClient = useQueryClient();
  const [duration, setDuration] = useState<number>(60);
  const [count, setCount] = useState<number>(3);
  const [captionStyle, setCaptionStyle] = useState<string>("bold_dynamic");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: GenerateHighlightsInput) =>
      api(`/projects/${projectId}/highlights/generate`, {
        method: "POST",
        body: input,
      }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-accent" />
        <CardTitle>
          {hasHighlights ? "Regenerate highlights" : "Generate AI highlights"}
        </CardTitle>
      </div>
      <CardDescription className="mt-1">
        The AI analyzes speech energy, pauses, scene changes{" "}
        {"—"} and the transcript when available {"—"} to suggest the
        best moments. Costs 2 credits.
      </CardDescription>

      <div className="mt-5 space-y-4">
        <div>
          <Label>Clip length</Label>
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((d) => (
              <OptionChip
                key={d}
                active={duration === d}
                onClick={() => setDuration(d)}
              >
                {d}s
              </OptionChip>
            ))}
          </div>
        </div>
        <div>
          <Label>Number of suggestions</Label>
          <div className="flex flex-wrap gap-2">
            {COUNTS.map((c) => (
              <OptionChip key={c} active={count === c} onClick={() => setCount(c)}>
                {c}
              </OptionChip>
            ))}
          </div>
        </div>
        <div>
          <Label>Caption style (used when creating clips)</Label>
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
        <FieldError message={error ?? undefined} />
        <Button
          className="w-full"
          loading={mutation.isPending}
          onClick={() =>
            mutation.mutate({
              clipDuration: duration,
              clipCount: count,
              format: "vertical",
              editingStyle: "dynamic_viral",
              captionStyle,
            })
          }
        >
          <Sparkles className="h-4 w-4" />
          {hasHighlights ? "Regenerate" : "Find the best moments"}
        </Button>
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
      className={cn(
        "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-primary/60 bg-primary/10 text-primary"
          : "border-border text-muted hover:border-border-strong hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
