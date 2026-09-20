"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Trash2,
  Loader2,
  AlertTriangle,
  Sparkles,
  Clock,
  Monitor,
  HardDrive,
} from "lucide-react";
import { api } from "@/lib/api";
import type { ProjectDetail } from "@/lib/types";
import { useProjectProgress } from "@/lib/use-project-progress";
import { formatBytes, formatDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress";
import { GenerateHighlightsCard } from "@/components/projects/generate-highlights-card";
import { HighlightList } from "@/components/projects/highlight-list";
import { ClipCard } from "@/components/projects/clip-card";
import { TranscriptPanel } from "@/components/projects/transcript-panel";

const PROCESSING_STATUSES = [
  "IMPORTING",
  "ANALYZING",
  "GENERATING_HIGHLIGHTS",
  "RENDERING",
];

/** Official YouTube player URL for a YouTube-sourced project, else null. */
function youtubeEmbedUrl(project: {
  sourceUrl: string | null;
  source: { sourceType: string } | null;
}): string | null {
  if (project.source?.sourceType !== "YOUTUBE" || !project.sourceUrl) return null;
  const id = new URL(project.sourceUrl).searchParams.get("v");
  return id ? `https://www.youtube.com/embed/${id}` : null;
}

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);

  const { data: project, isLoading } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<ProjectDetail>(`/projects/${projectId}`),
    // Poll while processing as a backup for the socket
    refetchInterval: (query) =>
      query.state.data && PROCESSING_STATUSES.includes(query.state.data.status)
        ? 4000
        : false,
  });

  const progress = useProjectProgress(projectId, (event) => {
    void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    if (event.clipId) {
      void queryClient.invalidateQueries({ queryKey: ["clip", event.clipId] });
    }
  });

  if (isLoading || !project) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted" />
      </div>
    );
  }

  const isProcessing = PROCESSING_STATUSES.includes(project.status);
  const showProgress =
    isProcessing && progress && !progress.clipId && progress.status === project.status;
  // Duration is only set once media has been imported (upload or YouTube download)
  const canGenerate = project.source?.duration != null && !isProcessing;

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${project.name}" and all its files? This cannot be undone.`)) {
      return;
    }
    setDeleting(true);
    try {
      await api(`/projects/${projectId}`, { method: "DELETE" });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      router.replace("/projects");
    } catch {
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/projects"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to projects
      </Link>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
            <StatusBadge status={project.status} />
          </div>
          {project.sourceUrl && (
            <p className="mt-1 text-sm text-muted">{project.sourceUrl}</p>
          )}
        </div>
        <Button
          variant="danger"
          size="sm"
          onClick={handleDelete}
          loading={deleting}
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </div>

      {isProcessing && (
        <Card className="mb-6">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <div className="flex-1">
              <CardTitle>
                {showProgress ? progress.step : "Processing your video…"}
              </CardTitle>
              <CardDescription>
                You can leave this page — processing continues in the background.
              </CardDescription>
            </div>
          </div>
          <ProgressBar
            className="mt-4"
            value={showProgress ? progress.progress : 15}
          />
        </Card>
      )}

      {project.status === "FAILED" && (
        <Card className="mb-6 border-danger/30 bg-danger/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
            <div>
              <CardTitle className="text-danger">Processing failed</CardTitle>
              <CardDescription className="mt-1">
                {project.error ??
                  "We could not process this source. Please try another video or upload a supported file."}
              </CardDescription>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-5">
        <Card className="overflow-hidden p-0 md:col-span-3">
          <div className="aspect-video w-full bg-black">
            {project.mediaUrl ? (
              <video
                src={project.mediaUrl}
                controls
                className="h-full w-full"
                poster={project.source?.thumbnailUrl ?? undefined}
              />
            ) : youtubeEmbedUrl(project) ? (
              // YouTube media is never stored, so preview via the official player
              <iframe
                src={youtubeEmbedUrl(project)!}
                title={project.source?.title ?? "YouTube video"}
                className="h-full w-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            ) : project.source?.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={project.source.thumbnailUrl}
                alt=""
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted">
                No preview available
              </div>
            )}
          </div>
          {project.source?.title && (
            <div className="p-4">
              <p className="truncate text-sm font-medium">
                {project.source.title}
              </p>
            </div>
          )}
        </Card>

        <div className="space-y-4 md:col-span-2">
          <Card>
            <CardTitle className="mb-3">Source details</CardTitle>
            <dl className="space-y-2.5 text-sm">
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-2 text-muted">
                  <Clock className="h-4 w-4" /> Duration
                </dt>
                <dd>{formatDuration(project.source?.duration)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-2 text-muted">
                  <Monitor className="h-4 w-4" /> Resolution
                </dt>
                <dd>
                  {project.source?.width && project.source?.height
                    ? `${project.source.width}×${project.source.height}`
                    : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-2 text-muted">
                  <HardDrive className="h-4 w-4" /> Size
                </dt>
                <dd>{formatBytes(project.source?.sizeBytes ?? null)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted">Rights</dt>
                <dd className="text-xs">{project.source?.rights ?? "—"}</dd>
              </div>
            </dl>
          </Card>

          {canGenerate ? (
            <GenerateHighlightsCard
              projectId={projectId}
              hasHighlights={project.highlights.length > 0}
            />
          ) : (
            <Card>
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-accent" />
                <CardTitle>AI highlights</CardTitle>
              </div>
              <CardDescription className="mt-2">
                Highlights become available once the video has been imported.
              </CardDescription>
            </Card>
          )}
        </div>
      </div>

      <section className="mt-6">
        <TranscriptPanel projectId={projectId} />
      </section>

      {project.highlights.length > 0 && (
        <section className="mt-8">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold">
              Highlight suggestions ({project.highlights.length})
            </h2>
          </div>
          <HighlightList projectId={projectId} highlights={project.highlights} />
        </section>
      )}

      {project.clips.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">
            Clips ({project.clips.length})
          </h2>
          <div className="space-y-4">
            {project.clips.map((clip) => (
              <ClipCard key={clip.id} clipId={clip.id} projectId={projectId} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
