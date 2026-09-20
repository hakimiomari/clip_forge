"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileText, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { TranscriptResponse } from "@/lib/types";
import { Card, CardTitle } from "@/components/ui/card";
import { formatDuration } from "@/lib/utils";

const STATUS_HINTS: Record<string, string> = {
  PENDING:
    "No transcript yet — it is fetched during highlight generation (YouTube captions are used automatically when available).",
  PROCESSING: "Transcription in progress…",
  UNAVAILABLE:
    "No transcript available. YouTube captions were not found and no transcription provider is configured (set TRANSCRIPTION_PROVIDER + TRANSCRIPTION_API_KEY in .env for automatic transcription of uploads).",
  FAILED: "Transcription failed.",
};

export function TranscriptPanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["transcript", projectId],
    queryFn: () => api<TranscriptResponse>(`/projects/${projectId}/transcript`),
    enabled: open,
  });

  return (
    <Card className="p-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 p-4 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted" />
        )}
        <FileText className="h-5 w-5 text-primary" />
        <CardTitle>Transcript</CardTitle>
        {data?.status === "COMPLETED" && (
          <span className="ml-auto text-xs text-muted">
            {data.segments.length} segments
            {data.language ? ` · ${data.language}` : ""}
            {data.provider ? ` · ${data.provider}` : ""}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border px-4 pb-4">
          {isLoading && (
            <div className="flex items-center gap-2 py-4 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {data && data.status !== "COMPLETED" && (
            <p className="py-4 text-sm text-muted">
              {STATUS_HINTS[data.status] ?? data.status}
              {data.status === "FAILED" && data.error ? ` ${data.error}` : ""}
            </p>
          )}
          {data?.status === "COMPLETED" && (
            <div className="mt-3 max-h-80 space-y-1.5 overflow-y-auto pr-2">
              {data.segments.map((s, i) => (
                <p key={i} className="text-sm leading-relaxed">
                  <span className="mr-2 font-mono text-xs text-muted">
                    {formatDuration(s.startTime)}
                  </span>
                  {s.speaker && (
                    <span className="mr-1 text-xs font-semibold text-accent">
                      {s.speaker}:
                    </span>
                  )}
                  <span className="text-muted-strong">{s.text}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
