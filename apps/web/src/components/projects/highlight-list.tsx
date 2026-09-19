"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, Quote } from "lucide-react";
import type { HighlightSummary } from "@clipforge/shared-types";
import { api, ApiError } from "@/lib/api";
import { formatDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FieldError } from "@/components/ui/input";

export function HighlightList({
  projectId,
  highlights,
  captionStyle = "bold_dynamic",
}: {
  projectId: string;
  highlights: HighlightSummary[];
  captionStyle?: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const createClip = useMutation({
    mutationFn: (highlightId: string) =>
      api(`/highlights/${highlightId}/create-clip`, {
        method: "POST",
        body: {
          format: "vertical",
          captionsEnabled: true,
          captionStyle,
          zoomEnabled: true,
        },
      }),
    onMutate: (id) => {
      setPendingId(id);
      setError(null);
    },
    onSettled: () => setPendingId(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });

  if (highlights.length === 0) return null;

  return (
    <div className="space-y-3">
      <FieldError message={error ?? undefined} />
      {highlights.map((h, i) => (
        <Card key={h.id} className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-accent/10 px-2 py-0.5 text-xs font-bold text-accent">
                  {h.score != null ? `${Math.round(h.score)}` : "–"} / 100
                </span>
                <span className="text-xs text-muted">
                  {formatDuration(h.startTime)} → {formatDuration(h.endTime)} ·{" "}
                  {Math.round(h.duration)}s
                </span>
                {h.category && (
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">
                    {h.category}
                  </span>
                )}
              </div>
              <h4 className="truncate font-semibold">
                {h.title ?? `Highlight ${i + 1}`}
              </h4>
              {h.hook && (
                <p className="mt-1 flex items-start gap-1.5 text-sm italic text-muted-strong">
                  <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="line-clamp-2">{h.hook}</span>
                </p>
              )}
              {h.reason && (
                <p className="mt-1 line-clamp-2 text-xs text-muted">{h.reason}</p>
              )}
            </div>
            <Button
              size="sm"
              loading={pendingId === h.id && createClip.isPending}
              onClick={() => createClip.mutate(h.id)}
            >
              <Clapperboard className="h-4 w-4" />
              Create clip
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
